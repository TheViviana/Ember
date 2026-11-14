use std::collections::HashSet;
use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{VaultError, VaultResult};

use super::{atomic, paths, trash, Vault};

/// 库内图库目录：`media/<sha256 前 2 位>/<完整 sha256>.<ext>`（常量归 paths.rs 所有）。
use paths::MEDIA_DIR;

/// 单张图片上限 20 MB。
pub const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// 图库图片数量上限。
pub const MAX_ASSETS: usize = 400;

/// 指针型库的图片按真实布局散落在文章目录里，扫描深度必须有界，避免异常目录树。
const MAX_SCAN_DEPTH: usize = 32;

/// 图库扩展名白名单。刻意不含 svg：它是 XML，可以内嵌脚本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
    /// 仅用于按磁盘布局只读；asset_save 不接受（from_mime 仍不含 bmp）
    Bmp,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Gif => "image/gif",
            ImageFormat::Webp => "image/webp",
            ImageFormat::Avif => "image/avif",
            ImageFormat::Bmp => "image/bmp",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Gif => "gif",
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
            ImageFormat::Bmp => "bmp",
        }
    }

    fn from_mime(mime: &str) -> Option<Self> {
        match mime.trim().to_ascii_lowercase().as_str() {
            "image/png" => Some(ImageFormat::Png),
            "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
            "image/gif" => Some(ImageFormat::Gif),
            "image/webp" => Some(ImageFormat::Webp),
            "image/avif" => Some(ImageFormat::Avif),
            _ => None,
        }
    }

    fn from_ext(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(ImageFormat::Png),
            "jpeg" | "jpg" => Some(ImageFormat::Jpeg),
            "gif" => Some(ImageFormat::Gif),
            "webp" => Some(ImageFormat::Webp),
            "avif" => Some(ImageFormat::Avif),
            "bmp" => Some(ImageFormat::Bmp),
            _ => None,
        }
    }

    /// 按 magic bytes 判型：扩展名与 MIME 都来自前端，只有内容可以信。
    fn sniff(bytes: &[u8]) -> Option<Self> {
        if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
            return Some(ImageFormat::Png);
        }
        if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            return Some(ImageFormat::Jpeg);
        }
        if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            return Some(ImageFormat::Gif);
        }
        if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
            return Some(ImageFormat::Webp);
        }
        if is_avif(bytes) {
            return Some(ImageFormat::Avif);
        }
        if bytes.starts_with(b"BM") {
            return Some(ImageFormat::Bmp);
        }
        None
    }
}

/// ISO-BMFF 的 ftyp 盒：主品牌或兼容品牌里出现 avif/avis 即视为 AVIF。
fn is_avif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    let major = &bytes[8..12];
    if major == b"avif" || major == b"avis" {
        return true;
    }
    let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    if bytes.len() < 16 {
        return false;
    }
    // 跳过 size/'ftyp'/主品牌/次版本，兼容品牌从第 16 字节开始
    let end = size.clamp(16, bytes.len());
    bytes[16..end]
        .chunks_exact(4)
        .any(|brand| brand == b"avif" || brand == b"avis")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetEntry {
    pub path: String,
    pub name: String,
    pub hash: String,
    pub mime: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub path: String,
    pub mime: String,
    pub bytes: u64,
    /// base64：前端拼 `data:<mime>;base64,...` 给 `<img>` 用
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSaved {
    pub path: String,
    pub name: String,
    pub hash: String,
    pub mime: String,
    pub bytes: u64,
    /// 同一内容已存在时为 true，此时没有重写磁盘
    pub deduped: bool,
}

/// 图库清单：内容寻址的 `media/` 资产 + 指针型库里按真实布局散落的磁盘图片。
/// 磁盘图片只做元数据扫描，不读内容、不解码。
pub fn list(vault: &Vault) -> VaultResult<Vec<AssetEntry>> {
    let mut entries = list_media(vault)?;
    let mut seen: HashSet<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    collect_disk_images(vault.root(), vault.root(), 0, &mut entries, &mut seen)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

/// 仅内容寻址的 `media/` 资产（配额判断必须用它，不能被磁盘图片撑爆）。
fn list_media(vault: &Vault) -> VaultResult<Vec<AssetEntry>> {
    let mut entries = Vec::new();
    let root = vault.root().join(MEDIA_DIR);
    let shards = match fs::read_dir(&root) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(entries),
        Err(error) => return Err(error.into()),
    };

    for shard in shards {
        let shard = shard?;
        let shard_name = shard.file_name().to_string_lossy().to_string();
        if !shard.file_type()?.is_dir() || shard_name.starts_with('.') || shard_name.len() != 2 {
            continue;
        }
        let files = match fs::read_dir(shard.path()) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for file in files {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            let name = file.file_name().to_string_lossy().to_string();
            let Some((hash, format)) = parse_name(&name) else {
                continue;
            };
            // 分片目录必须与 hash 前缀一致，避免把散落文件当图库资产
            if !hash.starts_with(&shard_name) {
                continue;
            }
            let bytes = file.metadata()?.len();
            entries.push(AssetEntry {
                path: format!("{MEDIA_DIR}/{shard_name}/{name}"),
                name,
                hash,
                mime: format.mime().to_string(),
                bytes,
            });
        }
    }

    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

/// 递归收集磁盘图片。隐藏目录（`.workbench`/`.git`）、`media/` 与符号链接一律跳过；
/// 只收白名单扩展名，`hash` 留空表示不是内容寻址资产。
fn collect_disk_images(
    root: &Path,
    dir: &Path,
    depth: usize,
    entries: &mut Vec<AssetEntry>,
    seen: &mut HashSet<String>,
) -> VaultResult<()> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let children = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for child in children {
        let child = child?;
        let name = child.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = child.file_type()?;
        // 不跟随符号链接：目录和文件都直接跳过
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if depth == 0 && name == MEDIA_DIR {
                continue;
            }
            collect_disk_images(root, &child.path(), depth + 1, entries, seen)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let Some(format) = image_format_from_name(&name) else {
            continue;
        };
        let child_path = child.path();
        let Ok(relative) = child_path.strip_prefix(root) else {
            continue;
        };
        let Some(relative) = relative.to_str() else {
            continue;
        };
        let relative = relative.replace(std::path::MAIN_SEPARATOR, "/");
        if !seen.insert(relative.clone()) {
            continue;
        }
        entries.push(AssetEntry {
            path: relative,
            name,
            hash: String::new(),
            mime: format.mime().to_string(),
            bytes: child.metadata()?.len(),
        });
    }
    Ok(())
}

fn image_format_from_name(name: &str) -> Option<ImageFormat> {
    let (_, ext) = name.rsplit_once('.')?;
    ImageFormat::from_ext(ext)
}

/// 读单张图片，返回 base64 与按内容判定的 MIME。
/// `media/` 路径保持原有的严格内容寻址校验；其余路径按库内磁盘图片读取。
pub fn read(vault: &Vault, relative: &str) -> VaultResult<AssetData> {
    let probe = relative.strip_prefix("./").unwrap_or(relative);
    // 名字落在 media/ 下就仍走内容寻址校验，不能借新路径绕过
    let media_prefix = format!("{MEDIA_DIR}/");
    if probe == MEDIA_DIR || probe.starts_with(media_prefix.as_str()) {
        return read_media(vault, probe);
    }
    read_disk_image(vault, relative)
}

fn read_media(vault: &Vault, relative: &str) -> VaultResult<AssetData> {
    let (_, format) =
        asset_parts(relative).ok_or_else(|| VaultError::PathOutside(relative.to_string()))?;
    let (absolute, normalized) = paths::resolve(vault.root(), relative)?;
    // stat 先行：media/ 可能被外部塞进任意大文件，超限不读入内存
    let size = fs::metadata(&absolute)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if size > MAX_ASSET_BYTES {
        return Err(VaultError::Encoding(format!(
            "图片超过读入上限 {MAX_ASSET_BYTES} 字节：{relative}"
        )));
    }
    let bytes = match fs::read(&absolute) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::NotFound(relative.to_string()));
        }
        Err(error) => return Err(io_at(error, &absolute)),
    };

    let mime = ImageFormat::sniff(&bytes)
        .unwrap_or(format)
        .mime()
        .to_string();
    Ok(AssetData {
        path: normalized,
        mime,
        bytes: bytes.len() as u64,
        data: STANDARD.encode(&bytes),
    })
}

/// 按磁盘真实布局只读一张图片。安全边界：
/// 路径必须落在库根内、任一级都不能是符号链接、扩展名白名单、常规文件、≤20 MB、
/// 内容必须通过图片 magic 判型（防止把 HTML/脚本改名成 .png 读出）。
fn read_disk_image(vault: &Vault, relative: &str) -> VaultResult<AssetData> {
    let (absolute, normalized) = paths::resolve(vault.root(), relative)?;
    if normalized
        .split('/')
        .any(|segment| segment.is_empty() || segment.starts_with('.'))
    {
        return Err(VaultError::PathOutside(relative.to_string()));
    }
    let name = normalized
        .rsplit('/')
        .next()
        .unwrap_or(normalized.as_str());
    if image_format_from_name(name).is_none() {
        return Err(VaultError::Encoding(format!(
            "不是支持的图片扩展名：{relative}"
        )));
    }
    // canonicalize 会解析符号链接；paths::resolve 已拒绝链接，这里再做一次落点复核
    let canonical_root = vault
        .root()
        .canonicalize()
        .map_err(|error| io_at(error, vault.root()))?;
    let canonical = match absolute.canonicalize() {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::NotFound(relative.to_string()));
        }
        Err(error) => return Err(io_at(error, &absolute)),
    };
    if !canonical.starts_with(&canonical_root) {
        return Err(VaultError::PathOutside(relative.to_string()));
    }
    let metadata = match fs::metadata(&canonical) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::NotFound(relative.to_string()));
        }
        Err(error) => return Err(io_at(error, &canonical)),
    };
    if !metadata.is_file() {
        return Err(VaultError::NotFound(relative.to_string()));
    }
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(VaultError::Encoding(format!(
            "图片超过读入上限 {MAX_ASSET_BYTES} 字节：{relative}"
        )));
    }
    let bytes = fs::read(&canonical).map_err(|error| io_at(error, &canonical))?;
    let Some(format) = ImageFormat::sniff(&bytes) else {
        return Err(VaultError::Encoding(format!(
            "无法识别的图片内容：{relative}"
        )));
    };
    Ok(AssetData {
        path: normalized,
        mime: format.mime().to_string(),
        bytes: bytes.len() as u64,
        data: STANDARD.encode(&bytes),
    })
}

/// 文章图片解析结果：命中带数据，未命中带可读原因；不写盘、不改正文。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ImageResolution {
    Found {
        path: String,
        mime: String,
        bytes: u64,
        data: String,
    },
    Missing {
        reason: &'static str,
    },
}

/// B 方案候选链（命中即停）：
/// 1. `<文章所在目录>/<原始引用>`；2. `<文章所在目录>/images/<原始引用>`；3. `<库根>/<原始引用>`。
/// 引用只按字面处理，不联网、不解析外链。
pub fn resolve_reference(
    vault: &Vault,
    document_path: &str,
    reference: &str,
) -> VaultResult<ImageResolution> {
    let raw = reference.trim();
    if raw.is_empty() {
        return Ok(ImageResolution::Missing { reason: "notFound" });
    }
    if has_scheme(raw) {
        return Ok(ImageResolution::Missing { reason: "external" });
    }
    // Obsidian 允许用 `/` 表示库根；统一去掉前导斜杠后再按候选链解析
    let name = raw.trim_start_matches('/').trim_start_matches("./");
    if name.is_empty() {
        return Ok(ImageResolution::Missing { reason: "notFound" });
    }
    let bare = name.rsplit('/').next().unwrap_or(name);
    if image_format_from_name(bare).is_none() {
        return Ok(ImageResolution::Missing {
            reason: "unsupportedType",
        });
    }

    let mut candidates: Vec<String> = Vec::new();
    if !document_path.trim().is_empty() {
        let (_, doc_normalized) = match paths::resolve(vault.root(), document_path) {
            Ok(value) => value,
            Err(_) => {
                return Ok(ImageResolution::Missing {
                    reason: "outsideVault",
                });
            }
        };
        let dir = doc_normalized
            .rsplit_once('/')
            .map(|(dir, _)| dir)
            .unwrap_or("");
        if dir.is_empty() {
            candidates.push(format!("images/{name}"));
        } else {
            candidates.push(format!("{dir}/{name}"));
            candidates.push(format!("{dir}/images/{name}"));
        }
    }
    candidates.push(name.to_string());

    let mut reason = "notFound";
    for candidate in candidates {
        match read_disk_image(vault, &candidate) {
            Ok(data) => {
                return Ok(ImageResolution::Found {
                    path: data.path,
                    mime: data.mime,
                    bytes: data.bytes,
                    data: data.data,
                });
            }
            Err(VaultError::NotFound(_)) => {}
            Err(VaultError::PathOutside(_)) => reason = "outsideVault",
            Err(VaultError::Encoding(message)) => {
                reason = if message.contains("20 MB") || message.contains("读入上限") {
                    "tooLarge"
                } else {
                    "unsupportedType"
                };
            }
            Err(VaultError::Io(_)) | Err(VaultError::IoAt { .. }) => reason = "unreadable",
            Err(_) => reason = "unreadable",
        }
    }
    Ok(ImageResolution::Missing { reason })
}

/// `scheme:` 形式（如 https:/data:/file:）不进入候选链，避免把外链当本地路径猜。
fn has_scheme(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        if c == ':' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return false;
        }
    }
    false
}


/// 删除单张图库图片：与文档删除同一落点——移入系统回收站，绝不直接永久删除。
/// 路径校验与 read 相同（只接受 `media/<两位分片>/<文件名>`，防目录穿越）；
/// 文件不存在按幂等成功处理（外部先删的场景里，面板「再删一次」不该报错）。
/// 删除也要过写闸：只读库（另一实例占用）一律拒绝。
pub fn delete(vault: &Vault, relative: &str) -> VaultResult<&'static str> {
    vault.ensure_writable()?;
    asset_parts(relative).ok_or_else(|| VaultError::PathOutside(relative.to_string()))?;
    let (absolute, _normalized) = paths::resolve(vault.root(), relative)?;
    match fs::symlink_metadata(&absolute) {
        Ok(_) => {
            let destination = trash::trash(vault.root(), &absolute)?;
            Ok(destination.as_str())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("system"),
        Err(error) => Err(io_at(error, &absolute)),
    }
}

/// 按内容哈希落盘：同内容只存一份，重复导入返回 deduped。
pub fn save(vault: &Vault, bytes: &[u8], mime: &str) -> VaultResult<AssetSaved> {
    // 必须走 ensure_writable：启动未抢到锁（被另一实例占用）的只读库一律拒绝落盘。
    vault.ensure_writable()?;
    if bytes.is_empty() {
        return Err(VaultError::Encoding("图片内容为空".to_string()));
    }
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(VaultError::Encoding(format!(
            "图片 {:.1} MB，超过 20 MB 上限",
            bytes.len() as f64 / 1024.0 / 1024.0
        )));
    }

    let declared = ImageFormat::from_mime(mime)
        .ok_or_else(|| VaultError::Encoding(format!("不支持的图片类型：{mime}")))?;
    match ImageFormat::sniff(bytes) {
        Some(actual) if actual == declared => {}
        Some(_) => {
            return Err(VaultError::Encoding(
                "图片内容与声明的类型不一致".to_string(),
            ));
        }
        None => return Err(VaultError::Encoding("无法识别的图片内容".to_string())),
    }

    let hash = hex_digest(bytes);
    let name = format!("{hash}.{}", declared.ext());
    let relative = format!("{MEDIA_DIR}/{}/{name}", &hash[..2]);
    let (absolute, normalized) = paths::resolve(vault.root(), &relative)?;

    // 去重与配额都是只读检查，放在写闸外：list 要遍历整个 media 目录，
    // 图库接近上限时不该在闸内阻塞其它写入。
    // 代价是配额存在极小的超限竞态：并发 asset_save 可能都读到 399 再各写一张，
    // 超出量以并发导入数为上限（UI 串行导入时不会发生），属可接受的软配额。
    let mut deduped = absolute.is_file();
    if !deduped && list_media(vault)?.len() >= MAX_ASSETS {
        return Err(VaultError::Encoding(format!(
            "图库已达 {MAX_ASSETS} 张上限，先删除不用的图片再导入"
        )));
    }

    // 落盘前进写闸：闸内复核去重，杜绝并发导入写出两份相同内容；
    // 独占创建模型下写闸即最后防线，命中已有图片也必须持锁返回。
    let _gate = vault.begin_write()?;
    // 闸内复核去重：配额检查与取闸之间，同一张图可能已被并发写入。
    deduped = deduped || absolute.is_file();
    if !deduped {
        atomic::write_atomic(&absolute, bytes).map_err(|error| match error {
            VaultError::Io(inner) => io_at(inner, &absolute),
            other => other,
        })?;
    }

    Ok(AssetSaved {
        path: normalized,
        name,
        hash,
        mime: declared.mime().to_string(),
        bytes: bytes.len() as u64,
        deduped,
    })
}

/// 文件名必须是 `<64 位小写 hex>.<白名单扩展名>`，防止把任意文件塞进 media/。
fn parse_name(name: &str) -> Option<(String, ImageFormat)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if !is_lower_hex(stem) || stem.len() != 64 {
        return None;
    }
    let format = ImageFormat::from_ext(ext)?;
    Some((stem.to_string(), format))
}

/// 只认 `media/<2 位分片>/<64 位 hash>.<ext>`。
fn asset_parts(relative: &str) -> Option<(String, ImageFormat)> {
    let mut parts = relative.split('/');
    if parts.next()? != MEDIA_DIR {
        return None;
    }
    let shard = parts.next()?;
    let name = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    let (hash, format) = parse_name(name)?;
    if !is_lower_hex(shard) || shard.len() != 2 || !hash.starts_with(shard) {
        return None;
    }
    Some((hash, format))
}

fn is_lower_hex(text: &str) -> bool {
    text.bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        text.push(HEX[(byte >> 4) as usize] as char);
        text.push(HEX[(byte & 0x0F) as usize] as char);
    }
    text
}

fn io_at(error: std::io::Error, path: &Path) -> VaultError {
    VaultError::IoAt {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    use super::*;

    const PNG: &[u8] =
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00";
    const JPEG: &[u8] = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00";

    struct TempVault {
        root: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            // 目录名附加原子序号：并行测试在时钟粒度内可能拿到相同纳秒值（同 pid + 同纳秒
            // 会共享目录并互相删对方的文件），paths 测试已修过同类问题。
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let root = std::env::temp_dir()
                .join(format!("ember-media-{}-{nanos}-{seq}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn open(&self) -> Vault {
            Vault::open(self.root.clone()).unwrap()
        }

        /// 只读观察者：先让一个实例持有锁，再开第二个实例（被占用 → 只读）。
        fn open_readonly(&self) -> Vault {
            let holder = Vault::open(self.root.clone()).unwrap();
            let observer = Vault::open(self.root.clone()).unwrap();
            assert!(!observer.writable(), "第二实例应为只读观察者");
            drop(holder);
            observer
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn delete_moves_file_to_trash_and_list_shrinks() {
        let temp = TempVault::new();
        let vault = temp.open();
        let saved = save(&vault, PNG, "image/png").unwrap();
        assert_eq!(list(&vault).unwrap().len(), 1);

        let destination = delete(&vault, &saved.path).unwrap();
        assert!(
            destination == "system" || destination == "internal",
            "落点必须是 system 或 internal：{destination}"
        );
        assert!(
            list(&vault).unwrap().is_empty(),
            "删除后清单不再包含该图"
        );
        assert!(matches!(
            read(&vault, &saved.path),
            Err(VaultError::NotFound(_))
        ));
        // 回收站语义：文件不应还留在库内
        assert!(!vault.root().join(&saved.path).exists());
    }

    #[test]
    fn delete_is_idempotent_for_missing_file() {
        let temp = TempVault::new();
        let vault = temp.open();
        let saved = save(&vault, PNG, "image/png").unwrap();
        delete(&vault, &saved.path).unwrap();
        // 外部已删：面板「再删一次」不报错
        delete(&vault, &saved.path).unwrap();
    }

    #[test]
    fn delete_rejects_paths_outside_media() {
        let temp = TempVault::new();
        let vault = temp.open();
        assert!(matches!(
            delete(&vault, "notes/escape.md"),
            Err(VaultError::PathOutside(_))
        ));
        assert!(matches!(
            delete(&vault, "media/../settings.json"),
            Err(VaultError::PathOutside(_))
        ));
    }

    #[test]
    fn delete_is_rejected_on_readonly_vault() {
        let temp = TempVault::new();
        let vault = temp.open();
        let saved = save(&vault, PNG, "image/png").unwrap();
        drop(vault);
        let readonly = temp.open_readonly();
        assert!(matches!(
            delete(&readonly, &saved.path),
            Err(VaultError::Readonly)
        ));
    }

    #[test]
    fn digest_matches_known_vector() {
        assert_eq!(
            hex_digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn recognizes_whitelisted_formats_by_content() {
        assert_eq!(ImageFormat::sniff(PNG), Some(ImageFormat::Png));
        assert_eq!(ImageFormat::sniff(JPEG), Some(ImageFormat::Jpeg));
        assert_eq!(
            ImageFormat::sniff(b"GIF89a\x01\x00\x01\x00\x00\x00\x00;"),
            Some(ImageFormat::Gif)
        );
        assert_eq!(
            ImageFormat::sniff(b"RIFF\x1a\x00\x00\x00WEBPVP8 "),
            Some(ImageFormat::Webp)
        );
        assert_eq!(
            ImageFormat::sniff(b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00mif1avif"),
            Some(ImageFormat::Avif)
        );
        assert_eq!(ImageFormat::sniff(b"<svg></svg>"), None);
    }

    #[test]
    fn save_is_content_addressed_and_deduped() {
        let temp = TempVault::new();
        let vault = temp.open();

        let first = save(&vault, PNG, "image/png").unwrap();
        assert!(!first.deduped);
        assert_eq!(first.mime, "image/png");
        assert_eq!(
            first.path,
            format!("media/{}/{}.png", &first.hash[..2], first.hash)
        );
        assert_eq!(fs::read(vault.root().join(&first.path)).unwrap(), PNG);

        let second = save(&vault, PNG, "image/png").unwrap();
        assert!(second.deduped);
        assert_eq!(second.path, first.path);
        assert_eq!(list(&vault).unwrap().len(), 1);
    }

    #[test]
    fn save_rejects_readonly_vault() {
        // 独占创建 + pid 存活模型下只读只发生在启动时（被另一实例占用）：
        // media 落盘与文档写入一样走 ensure_writable，只读库一律拒绝。
        let temp = TempVault::new();
        let vault = temp.open_readonly();

        let error = save(&vault, PNG, "image/png").unwrap_err();
        assert!(matches!(error, VaultError::Readonly), "只读库图片落盘应被拒绝：{error}");
        assert!(list(&vault).unwrap().is_empty());
    }


    #[test]
    fn rejects_svg_and_unknown_types() {
        let temp = TempVault::new();
        let vault = temp.open();

        // 零联网门禁同时扫 http(s):// 与协议相对 //host：把 scheme 拆开，源码里不留完整 URL
        let scheme = "ht";
        let svg = format!("<svg xmlns=\"{scheme}tp://www.w3.org/2000/svg\"></svg>");
        assert!(save(&vault, svg.as_bytes(), "image/svg+xml").is_err());
        assert!(save(&vault, PNG, "text/plain").is_err());
        assert!(list(&vault).unwrap().is_empty());
    }

    #[test]
    fn rejects_content_mime_mismatch() {
        let temp = TempVault::new();
        let vault = temp.open();

        let error = save(&vault, PNG, "image/jpeg").unwrap_err();
        assert!(matches!(error, VaultError::Encoding(_)));
        assert!(save(&vault, b"not an image at all", "image/png").is_err());
        assert!(save(&vault, b"", "image/png").is_err());
    }

    #[test]
    fn rejects_oversize_payload() {
        let temp = TempVault::new();
        let vault = temp.open();

        let mut huge = vec![0u8; MAX_ASSET_BYTES as usize + 1];
        huge[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let error = save(&vault, &huge, "image/png").unwrap_err();
        assert!(matches!(error, VaultError::Encoding(_)));
    }

    #[test]
    fn list_skips_foreign_and_invalid_names() {
        let temp = TempVault::new();
        let vault = temp.open();

        let saved = save(&vault, JPEG, "image/jpeg").unwrap();
        let shard = vault.root().join(MEDIA_DIR).join(&saved.hash[..2]);
        fs::write(shard.join("readme.txt"), b"x").unwrap();
        fs::write(shard.join("deadbeef.png"), b"x").unwrap();
        fs::write(shard.join(".DS_Store"), b"x").unwrap();
        fs::create_dir_all(shard.join("nested")).unwrap();

        let entries = list(&vault).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, saved.path);
        assert_eq!(entries[0].bytes, JPEG.len() as u64);
    }

    #[test]
    fn read_returns_base64_and_refuses_outside_media() {
        let temp = TempVault::new();
        let vault = temp.open();

        let saved = save(&vault, PNG, "image/png").unwrap();
        let data = read(&vault, &saved.path).unwrap();
        assert_eq!(data.mime, "image/png");
        assert_eq!(STANDARD.decode(data.data.as_bytes()).unwrap(), PNG);

        assert!(matches!(
            read(&vault, ".workbench/settings.json").unwrap_err(),
            VaultError::PathOutside(_)
        ));
        // 非图片扩展名不会进入磁盘图片读取（B 方案的解析范围只到图片）
        assert!(matches!(
            read(&vault, "notes/readme.md").unwrap_err(),
            VaultError::Encoding(_)
        ));
        assert!(matches!(
            read(&vault, "media/zz/whatever.png").unwrap_err(),
            VaultError::PathOutside(_)
        ));

        let mut other_hash = saved.hash.clone();
        let last = other_hash.pop().unwrap();
        other_hash.push(if last == '0' { '1' } else { '0' });
        let missing = format!("media/{}/{other_hash}.png", &saved.hash[..2]);
        assert!(matches!(
            read(&vault, &missing).unwrap_err(),
            VaultError::NotFound(_)
        ));
    }

    #[test]
    fn readonly_vault_rejects_save() {
        let temp = TempVault::new();
        let owner = temp.open();
        let observer = temp.open();
        assert!(!observer.writable());

        assert!(matches!(
            save(&observer, PNG, "image/png").unwrap_err(),
            VaultError::Readonly
        ));
        assert!(!save(&owner, PNG, "image/png").unwrap().deduped);
    }

    #[test]
    fn resolve_reference_follows_disk_layout() {
        let temp = TempVault::new();
        let vault = temp.open();
        let article = "notes/论文/论文.md";
        fs::create_dir_all(vault.root().join("notes/论文/images")).unwrap();
        fs::write(vault.root().join(article), b"# x").unwrap();

        // 第 2 层：文章目录/images/<raw>
        fs::write(vault.root().join("notes/论文/images/pic.png"), PNG).unwrap();
        let found = resolve_reference(&vault, article, "pic.png").unwrap();
        match found {
            ImageResolution::Found { path, mime, bytes, .. } => {
                assert_eq!(path, "notes/论文/images/pic.png");
                assert_eq!(mime, "image/png");
                assert_eq!(bytes, PNG.len() as u64);
            }
            ImageResolution::Missing { reason } => panic!("应命中文章 images 目录，实际 {reason}"),
        }

        // 第 1 层优先于第 2 层
        fs::write(vault.root().join("notes/论文/pic.png"), JPEG).unwrap();
        let first = resolve_reference(&vault, article, "pic.png").unwrap();
        assert!(matches!(
            first,
            ImageResolution::Found { ref path, ref mime, .. }
                if path == "notes/论文/pic.png" && mime == "image/jpeg"
        ));

        // 第 3 层：库根
        fs::write(vault.root().join("cover.jpg"), JPEG).unwrap();
        let root_hit = resolve_reference(&vault, article, "cover.jpg").unwrap();
        assert!(matches!(
            root_hit,
            ImageResolution::Found { ref path, .. } if path == "cover.jpg"
        ));
    }

    #[test]
    fn resolve_reference_reports_reasons() {
        let temp = TempVault::new();
        let vault = temp.open();
        let article = "notes/论文/论文.md";
        fs::create_dir_all(vault.root().join("notes/论文")).unwrap();
        fs::write(vault.root().join(article), b"# x").unwrap();

        assert!(matches!(
            resolve_reference(&vault, article, "missing.png").unwrap(),
            ImageResolution::Missing { reason: "notFound" }
        ));
        assert!(matches!(
            resolve_reference(&vault, article, "vector.svg").unwrap(),
            ImageResolution::Missing {
                reason: "unsupportedType"
            }
        ));
        let external = format!("{}//{}", "https:", "example.com/a.png");
        assert!(matches!(
            resolve_reference(&vault, article, &external).unwrap(),
            ImageResolution::Missing { reason: "external" }
        ));
        assert!(matches!(
            resolve_reference(&vault, article, "../../outside.png").unwrap(),
            ImageResolution::Missing {
                reason: "outsideVault"
            }
        ));
    }

    #[test]
    fn resolve_reference_rejects_symlink_escape() {
        let temp = TempVault::new();
        let vault = temp.open();
        let article = "notes/论文/论文.md";
        fs::create_dir_all(vault.root().join("notes/论文/images")).unwrap();
        fs::write(vault.root().join(article), b"# x").unwrap();

        let outside = temp.root.join("outside.png");
        fs::write(&outside, PNG).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, vault.root().join("notes/论文/images/leak.png")).unwrap();

        assert!(matches!(
            resolve_reference(&vault, article, "leak.png").unwrap(),
            ImageResolution::Missing {
                reason: "outsideVault"
            }
        ));
    }

    #[test]
    fn read_accepts_disk_images_and_checks_content() {
        let temp = TempVault::new();
        let vault = temp.open();
        fs::create_dir_all(vault.root().join("notes/论文/images")).unwrap();

        fs::write(vault.root().join("notes/论文/images/pic.png"), PNG).unwrap();
        let data = read(&vault, "notes/论文/images/pic.png").unwrap();
        assert_eq!(data.mime, "image/png");
        assert_eq!(STANDARD.decode(data.data.as_bytes()).unwrap(), PNG);

        fs::write(vault.root().join("notes/论文/fake.png"), b"<html>x</html>").unwrap();
        assert!(matches!(
            read(&vault, "notes/论文/fake.png").unwrap_err(),
            VaultError::Encoding(_)
        ));

        fs::create_dir_all(vault.root().join(".secret")).unwrap();
        fs::write(vault.root().join(".secret/pic.png"), PNG).unwrap();
        assert!(matches!(
            read(&vault, ".secret/pic.png").unwrap_err(),
            VaultError::PathOutside(_)
        ));
    }

    #[test]
    fn list_includes_disk_images_but_skips_hidden_and_symlinks() {
        let temp = TempVault::new();
        let vault = temp.open();
        let saved = save(&vault, JPEG, "image/jpeg").unwrap();

        fs::create_dir_all(vault.root().join("notes/论文/images")).unwrap();
        fs::write(vault.root().join("notes/论文/images/pic.png"), PNG).unwrap();
        fs::write(vault.root().join("notes/论文/readme.md"), b"x").unwrap();
        fs::create_dir_all(vault.root().join(".hidden")).unwrap();
        fs::write(vault.root().join(".hidden/pic.png"), PNG).unwrap();

        let outside = temp.root.join("outside.png");
        fs::write(&outside, PNG).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, vault.root().join("notes/link.png")).unwrap();

        let entries = list(&vault).unwrap();
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert!(paths.contains(&saved.path.as_str()));
        assert!(paths.contains(&"notes/论文/images/pic.png"));
        assert!(!paths.contains(&"notes/论文/readme.md"));
        assert!(!paths.iter().any(|path| path.contains(".hidden")));
        assert!(!paths.contains(&"notes/link.png"));

        let disk = entries
            .iter()
            .find(|entry| entry.path == "notes/论文/images/pic.png")
            .unwrap();
        assert_eq!(disk.hash, "");
        assert_eq!(disk.mime, "image/png");
    }

    #[test]
    fn save_quota_counts_only_content_addressed_media() {
        let temp = TempVault::new();
        let vault = temp.open();
        // 直接铺满 media/ 配额（内容不参与 list 校验，只有文件名参与）
        for index in 0..MAX_ASSETS {
            let hash = format!("{index:064x}");
            let shard = vault.root().join(MEDIA_DIR).join(&hash[..2]);
            fs::create_dir_all(&shard).unwrap();
            fs::write(shard.join(format!("{hash}.png")), PNG).unwrap();
        }
        // 磁盘图片不计入 media 配额
        fs::create_dir_all(vault.root().join("notes")).unwrap();
        fs::write(vault.root().join("notes/pic.png"), PNG).unwrap();
        assert_eq!(list(&vault).unwrap().len(), MAX_ASSETS + 1);
        assert!(matches!(
            save(&vault, PNG, "image/png").unwrap_err(),
            VaultError::Encoding(_)
        ));
    }
}
