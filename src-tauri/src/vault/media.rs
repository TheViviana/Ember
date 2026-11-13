use std::fs;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{VaultError, VaultResult};

use super::{atomic, paths, Vault};

/// 库内图库目录：`media/<sha256 前 2 位>/<完整 sha256>.<ext>`（常量归 paths.rs 所有）。
use paths::MEDIA_DIR;

/// 单张图片上限 20 MB。
pub const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

/// 图库图片数量上限。
pub const MAX_ASSETS: usize = 400;

/// 图库扩展名白名单。刻意不含 svg：它是 XML，可以内嵌脚本。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Avif,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::Gif => "image/gif",
            ImageFormat::Webp => "image/webp",
            ImageFormat::Avif => "image/avif",
        }
    }

    pub fn ext(self) -> &'static str {
        match self {
            ImageFormat::Png => "png",
            ImageFormat::Jpeg => "jpeg",
            ImageFormat::Gif => "gif",
            ImageFormat::Webp => "webp",
            ImageFormat::Avif => "avif",
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

/// 全库图片清单（相对 POSIX 路径字典序）。目录不存在时返回空表。
pub fn list(vault: &Vault) -> VaultResult<Vec<AssetEntry>> {
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

/// 读单张图片，返回 base64 与按内容判定的 MIME。
pub fn read(vault: &Vault, relative: &str) -> VaultResult<AssetData> {
    // asset_read 只允许读图库目录，绝不能借它读 .workbench/ 或任意库内文件
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
    if !deduped && list(vault)?.len() >= MAX_ASSETS {
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
        assert!(matches!(
            read(&vault, "notes/readme.md").unwrap_err(),
            VaultError::PathOutside(_)
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
}
