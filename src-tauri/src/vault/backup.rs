//! 受控备份：整库导出 + 导出包只读预检（vault-format §11）。
//!
//! 边界：
//! - 只读库也允许导出（导出不写库）；
//! - 导出目标必须是库外的绝对路径，且不得已存在（不覆盖）；
//! - 目录映射冻结：Markdown → `docs/`（保留库内相对路径），`media/` → `assets/`，
//!   `.workbench/` 可选（settings + canvas + history，排除锁、临时文件、旧回收目录）；
//! - 遍历拒绝符号链接；拷贝时流式 SHA-256，写完后复核 staging 字节与源文件 hash，
//!   导出期间被外部改动即整体失败；
//! - 全部写完才 `rename` 成最终目录；任何失败都删除 staging，不在目标父目录留残包。
//! - 预检只读导出包，不读库、不写盘。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::error::{VaultError, VaultResult};
use crate::vault::{clock, paths, ulid, Vault};

const FORMAT: &str = "ember-export";
const FORMAT_VERSION: u64 = 1;
const MANIFEST: &str = "manifest.json";
const DOCS_PREFIX: &str = "docs";
const ASSETS_PREFIX: &str = "assets";
/// manifest 是小 JSON 文件；异常大包直接拒绝，避免把损坏文件整块读进内存。
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
/// 只读 frontmatter 需要的前缀字节；正文多长与 manifest 无关。
const MAX_FRONTMATTER_BYTES: u64 = 256 * 1024;
const COPY_BUFFER: usize = 64 * 1024;

static STAGING_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    /// 最终导出目录的绝对路径；必须不存在，且不得位于库内
    pub destination: String,
    #[serde(default = "default_true")]
    pub include_workbench: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub directory: String,
    pub manifest: String,
    pub documents: usize,
    pub assets: usize,
    pub workbench_files: usize,
    pub bytes: u64,
    pub include_workbench: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupIssue {
    /// error | conflict | warn
    pub severity: &'static str,
    pub code: &'static str,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectReport {
    pub directory: String,
    pub format: String,
    pub format_version: u64,
    pub exported_at: String,
    pub vault_name: String,
    pub include_workbench: bool,
    pub documents: usize,
    pub assets: usize,
    pub workbench_files: usize,
    pub total_bytes: u64,
    /// 没有 error 即视为可恢复；conflict 需要用户处理，warn 只提示
    pub restorable: bool,
    pub issues: Vec<BackupIssue>,
}

/// 库外默认导出目录：`~/Documents/Ember Export <库名> <YYYY-MM-DD>`。
pub fn default_destination(vault: &Vault) -> String {
    let home = std::env::var("HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let stamp = clock::now_iso8601();
    let date = stamp.get(..10).unwrap_or(stamp.as_str());
    // 不探测 `~/Documents` 是否存在：避免在设置面板加载时就触发 macOS 文稿授权弹窗；
    // 真正导出时由 `export()` 校验父目录，不存在会给出明确错误。
    let base = home.join("Documents");
    base.join(format!("Ember Export {} {date}", safe_name(&vault_name(vault))))
        .to_string_lossy()
        .to_string()
}

/// 导出整库到 `options.destination`（staging → 校验 → 原子改名）。
pub fn export(vault: &Vault, options: &ExportOptions) -> VaultResult<ExportReport> {
    let dest = PathBuf::from(&options.destination);
    if !dest.is_absolute() {
        return Err(VaultError::Encoding(format!(
            "导出目标必须是绝对路径：{}",
            options.destination
        )));
    }
    let parent_raw = dest
        .parent()
        .ok_or_else(|| VaultError::Encoding(format!("导出目标缺少父目录：{}", options.destination)))?;
    let parent = fs::canonicalize(parent_raw)
        .map_err(|_| VaultError::NotFound(parent_raw.display().to_string()))?;
    if !parent.is_dir() {
        return Err(VaultError::Encoding(format!(
            "导出目标的父路径不是目录：{}",
            parent.display()
        )));
    }
    let root = fs::canonicalize(vault.root())?;
    if parent.starts_with(&root) {
        return Err(VaultError::PathOutside(format!(
            "导出目标不得位于库内：{}",
            parent.display()
        )));
    }
    let name = dest
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .ok_or_else(|| VaultError::Encoding(format!("导出目标缺少目录名：{}", options.destination)))?;
    let dest = parent.join(&name);
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(VaultError::PathExists(dest.display().to_string()));
    }

    let entries = collect_entries(vault.root(), options.include_workbench)?;
    let staging = parent.join(format!(".{name}.ember-export-staging-{}", staging_suffix()));
    fs::create_dir_all(&staging).map_err(|error| io_at(error, &staging))?;

    let written = write_package(vault, &entries, &staging, options.include_workbench);
    let stats = match written {
        Ok(stats) => stats,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    if let Err(error) = fs::rename(&staging, &dest) {
        let _ = fs::remove_dir_all(&staging);
        return Err(io_at(error, &dest));
    }
    // 目录 fsync 让 rename 持久化；失败不回滚已完成的导出（包本身已完整），只忽略。
    if let Ok(handle) = File::open(&parent) {
        let _ = handle.sync_all();
    }

    Ok(ExportReport {
        directory: dest.to_string_lossy().to_string(),
        manifest: dest.join(MANIFEST).to_string_lossy().to_string(),
        documents: stats.documents,
        assets: stats.assets,
        workbench_files: stats.workbench_files,
        bytes: stats.bytes,
        include_workbench: options.include_workbench,
    })
}

struct PackageStats {
    documents: usize,
    assets: usize,
    workbench_files: usize,
    bytes: u64,
}

/// 一个待导出的文件：库内绝对路径 → 包内相对 POSIX 路径。
struct Entry {
    source: PathBuf,
    target: String,
}

fn collect_entries(root: &Path, include_workbench: bool) -> VaultResult<Vec<Entry>> {
    let mut entries = Vec::new();
    collect_documents(root, root, &mut entries)?;
    collect_assets(root, &mut entries)?;
    if include_workbench {
        collect_workbench(root, &mut entries)?;
    }
    entries.sort_by(|left, right| left.target.cmp(&right.target));
    Ok(entries)
}

fn collect_documents(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let listing = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, dir)),
    };
    for item in listing {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        let file_type = item.file_type()?;
        if file_type.is_symlink() {
            return Err(symlink_error(&item.path()));
        }
        if file_type.is_dir() {
            // 顶层 media/ 单独映射为 assets/；隐藏目录与依赖目录不进备份。
            if name == paths::WORKBENCH_DIR
                || name == paths::MEDIA_DIR
                || name == "node_modules"
                || name.starts_with('.')
            {
                continue;
            }
            collect_documents(root, &item.path(), entries)?;
            continue;
        }
        if !file_type.is_file() || name.starts_with('.') || name.contains(".ember-tmp-") {
            continue;
        }
        if !name.ends_with(".md") {
            continue;
        }
        push_entry(root, &item.path(), DOCS_PREFIX, entries)?;
    }
    Ok(())
}

fn collect_assets(root: &Path, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let media = root.join(paths::MEDIA_DIR);
    if !media.is_dir() {
        return Ok(());
    }
    collect_asset_tree(root, &media, entries)
}

fn collect_asset_tree(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let listing = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, dir)),
    };
    for item in listing {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        let file_type = item.file_type()?;
        if file_type.is_symlink() {
            return Err(symlink_error(&item.path()));
        }
        if file_type.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            collect_asset_tree(root, &item.path(), entries)?;
            continue;
        }
        if !file_type.is_file() || name.starts_with('.') || name.contains(".ember-tmp-") {
            continue;
        }
        push_entry(root, &item.path(), ASSETS_PREFIX, entries)?;
    }
    Ok(())
}

/// `.workbench/` 只备份 settings.json、canvas/*.json、history/**；
/// history 下含文档历史 `documents/<docId>/`，因此递归遍历；
/// 锁、临时文件、旧回收目录（trash、backup）一律排除。
fn collect_workbench(root: &Path, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let workbench = paths::workbench(root);
    if !workbench.is_dir() {
        return Ok(());
    }
    let settings = paths::settings_file(root);
    if settings.is_file() {
        push_entry(root, &settings, ".workbench", entries)?;
    }
    for folder in ["canvas", "history"] {
        collect_workbench_tree(root, &workbench.join(folder), entries)?;
    }
    Ok(())
}

fn collect_workbench_tree(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let listing = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, dir)),
    };
    for item in listing {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        let file_type = item.file_type()?;
        if file_type.is_symlink() {
            return Err(symlink_error(&item.path()));
        }
        if file_type.is_dir() {
            if name.starts_with('.') {
                continue;
            }
            collect_workbench_tree(root, &item.path(), entries)?;
            continue;
        }
        if !file_type.is_file() || name.starts_with('.') || name.contains(".ember-tmp-") {
            continue;
        }
        push_entry(root, &item.path(), ".workbench", entries)?;
    }
    Ok(())
}

fn push_entry(root: &Path, source: &Path, prefix: &str, entries: &mut Vec<Entry>) -> VaultResult<()> {
    let relative = source
        .strip_prefix(root)
        .map_err(|_| VaultError::PathOutside(source.display().to_string()))?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    let target = if prefix == ".workbench" {
        // 源路径本身就在 `.workbench/` 下：保留原相对路径，不再叠加前缀
        relative
    } else if prefix == ASSETS_PREFIX {
        // media/ab/x.png → assets/ab/x.png（去掉 media/ 前缀）
        let inner = relative
            .strip_prefix(&format!("{}/", paths::MEDIA_DIR))
            .unwrap_or(relative.as_str());
        format!("{ASSETS_PREFIX}/{inner}")
    } else {
        format!("{prefix}/{relative}")
    };
    entries.push(Entry {
        source: source.to_path_buf(),
        target,
    });
    Ok(())
}

fn write_package(
    vault: &Vault,
    entries: &[Entry],
    staging: &Path,
    include_workbench: bool,
) -> VaultResult<PackageStats> {
    let mut integrity: BTreeMap<String, String> = BTreeMap::new();
    let mut documents: Vec<Value> = Vec::new();
    let mut assets: Vec<Value> = Vec::new();
    let mut canvas_ids: Vec<String> = Vec::new();
    let mut settings_included = false;
    let mut stats = PackageStats {
        documents: 0,
        assets: 0,
        workbench_files: 0,
        bytes: 0,
    };

    for entry in entries {
        let target = staging.join(path_segments(&entry.target));
        let copied = copy_hashed(&entry.source, &target)?;
        // staging 复核：写出的字节必须与拷贝时算出的 hash 一致。
        let written = hash_file(&target)?;
        if written != copied.hash {
            return Err(VaultError::Encoding(format!(
                "备份写入校验失败：{}",
                entry.target
            )));
        }
        // 源文件复核：导出期间被外部改动即失败（不产出半新半旧的包）。
        verify_source_unchanged(&entry.source, &copied.hash)?;

        stats.bytes += copied.size;
        integrity.insert(entry.target.clone(), copied.hash.clone());

        if entry.target.starts_with(&format!("{DOCS_PREFIX}/")) {
            stats.documents += 1;
            documents.push(document_entry(&entry.source, entry.target.as_str(), &copied));
        } else if entry.target.starts_with(&format!("{ASSETS_PREFIX}/")) {
            stats.assets += 1;
            assets.push(json!({
                "path": entry.target,
                "contentHash": format!("sha256:{}", copied.hash),
                "size": copied.size,
            }));
        } else {
            stats.workbench_files += 1;
            if entry.target == ".workbench/settings.json" {
                settings_included = true;
            }
            if let Some(rest) = entry.target.strip_prefix(".workbench/canvas/") {
                if let Some(id) = rest.strip_suffix(".json") {
                    canvas_ids.push(id.to_string());
                }
            }
        }
    }
    canvas_ids.sort();

    let manifest = json!({
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "exportedAt": clock::now_iso8601(),
        "app": { "name": "Ember", "version": env!("CARGO_PKG_VERSION") },
        "vault": { "id": vault.id(), "name": vault_name(vault) },
        "includeWorkbench": include_workbench,
        "documents": documents,
        "assets": assets,
        "workbench": { "canvas": canvas_ids, "settings": settings_included },
        "integrity": { "algorithm": "sha256", "files": integrity },
    });
    let bytes = serde_json::to_vec_pretty(&manifest)?;
    let manifest_path = staging.join(MANIFEST);
    fs::write(&manifest_path, &bytes).map_err(|error| io_at(error, &manifest_path))?;
    Ok(stats)
}

/// manifest 里的文档条目：id/title/tags/aliases 来自 frontmatter，
/// 缺 id 时省略（预检会把它列为 warn，而不是伪造一个 id）。
fn document_entry(source: &Path, target: &str, copied: &Copied) -> Value {
    let meta = read_doc_meta(source);
    let mut map = Map::new();
    map.insert("path".to_string(), json!(target));
    if let Some(id) = meta.id {
        map.insert("id".to_string(), json!(id));
    }
    let title = meta
        .title
        .unwrap_or_else(|| file_stem(target).unwrap_or_else(|| "未命名".to_string()));
    map.insert("title".to_string(), json!(title));
    map.insert("tags".to_string(), json!(meta.tags));
    map.insert("aliases".to_string(), json!(meta.aliases));
    map.insert(
        "contentHash".to_string(),
        json!(format!("sha256:{}", copied.hash)),
    );
    map.insert("size".to_string(), json!(copied.size));
    Value::Object(map)
}

/// 只读导出包并给出可恢复 / 冲突 / 错误结论（不写盘、不读库）。
pub fn inspect(directory: &str) -> VaultResult<InspectReport> {
    let raw = PathBuf::from(directory);
    if !raw.is_absolute() {
        return Err(VaultError::Encoding(format!(
            "备份包路径必须是绝对路径：{directory}"
        )));
    }
    let root = fs::canonicalize(&raw).map_err(|_| VaultError::NotFound(directory.to_string()))?;
    if !root.is_dir() {
        return Err(VaultError::NotFound(directory.to_string()));
    }
    let manifest_path = root.join(MANIFEST);
    let meta = fs::metadata(&manifest_path).map_err(|_| VaultError::NotFound(manifest_path.display().to_string()))?;
    if meta.len() > MAX_MANIFEST_BYTES {
        return Err(VaultError::Encoding(format!(
            "manifest.json 超过 {} KB 上限",
            MAX_MANIFEST_BYTES / 1024
        )));
    }
    let text = fs::read_to_string(&manifest_path).map_err(|error| io_at(error, &manifest_path))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| VaultError::Encoding(format!("manifest.json 不是合法 JSON：{error}")))?;

    let format = value
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let format_version = value
        .get("formatVersion")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let exported_at = value
        .get("exportedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let vault_name = value
        .pointer("/vault/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let include_workbench = value
        .get("includeWorkbench")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let mut issues: Vec<BackupIssue> = Vec::new();
    if format != FORMAT {
        issues.push(issue(
            "error",
            "invalid_format",
            None,
            format!("不是 Ember 导出包：format={format}"),
        ));
    }
    if format_version != FORMAT_VERSION {
        issues.push(issue(
            "error",
            "unsupported_version",
            None,
            format!("导出包 formatVersion={format_version}，当前应用只支持 {FORMAT_VERSION}"),
        ));
    }

    let documents = value
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let assets = value
        .get("assets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    // 文档身份：缺失 warn、非法 conflict、重复 conflict
    let mut id_counts: HashMap<String, usize> = HashMap::new();
    for item in &documents {
        let Some(path) = item.get("path").and_then(Value::as_str) else {
            issues.push(issue(
                "error",
                "invalid_manifest",
                None,
                "documents[] 条目缺少 path".to_string(),
            ));
            continue;
        };
        match item.get("id").and_then(Value::as_str) {
            None => {
                issues.push(issue(
                    "warn",
                    "missing_id",
                    Some(path.to_string()),
                    "文档没有 frontmatter id（adoption 前不能按身份去重）".to_string(),
                ));
            }
            Some(id) if !ulid::is_ulid(id) => issues.push(issue(
                "conflict",
                "invalid_id",
                Some(path.to_string()),
                format!("id 不是合法 ULID：{id}"),
            )),
            Some(id) => *id_counts.entry(id.to_string()).or_insert(0) += 1,
        }
    }
    for (id, count) in id_counts {
        if count > 1 {
            issues.push(issue(
                "conflict",
                "duplicate_id",
                None,
                format!("同一 id 出现 {count} 次：{id}"),
            ));
        }
    }
    let declared: Vec<String> = documents
        .iter()
        .chain(assets.iter())
        .filter_map(|item| item.get("path").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    check_duplicate_paths(&declared, &mut issues);
    for path in &declared {
        if let Err((code, message)) = validate_export_path(path, include_workbench) {
            issues.push(issue("error", code, Some(path.clone()), message));
        }
    }

    let files = value
        .pointer("/integrity/files")
        .and_then(Value::as_object)
        .cloned();
    let mut documents_count = 0usize;
    let mut assets_count = 0usize;
    let mut workbench_count = 0usize;
    let mut total_bytes = 0u64;

    let Some(files) = files else {
        issues.push(issue(
            "error",
            "invalid_manifest",
            None,
            "缺少 integrity.files，无法校验内容".to_string(),
        ));
        return Ok(InspectReport {
            directory: root.to_string_lossy().to_string(),
            format,
            format_version,
            exported_at,
            vault_name,
            include_workbench,
            documents: 0,
            assets: 0,
            workbench_files: 0,
            total_bytes: 0,
            restorable: false,
            issues,
        });
    };

    let mut integrity_paths: Vec<(String, String)> = Vec::new();
    for (path, hash) in &files {
        let Some(hash) = hash.as_str() else {
            issues.push(issue(
                "error",
                "invalid_manifest",
                Some(path.clone()),
                "integrity 条目不是字符串".to_string(),
            ));
            continue;
        };
        integrity_paths.push((path.clone(), hash.to_string()));
    }
    integrity_paths.sort();
    let integrity_names: Vec<String> = integrity_paths
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    check_duplicate_paths(&integrity_names, &mut issues);

    let mut known: HashSet<String> = HashSet::new();
    for (path, expected) in &integrity_paths {
        if let Err((code, message)) = validate_export_path(path, include_workbench) {
            issues.push(issue("error", code, Some(path.clone()), message));
            continue;
        }
        known.insert(path.clone());
        if path.starts_with(&format!("{DOCS_PREFIX}/")) {
            documents_count += 1;
        } else if path.starts_with(&format!("{ASSETS_PREFIX}/")) {
            assets_count += 1;
        } else if path.starts_with(".workbench/") {
            workbench_count += 1;
        }
        let absolute = join_export(&root, path);
        let metadata = match fs::symlink_metadata(&absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                issues.push(issue(
                    "error",
                    "missing_file",
                    Some(path.clone()),
                    "包内缺少 integrity 声明的文件".to_string(),
                ));
                continue;
            }
            Err(error) => return Err(io_at(error, &absolute)),
        };
        if metadata.file_type().is_symlink() {
            issues.push(issue(
                "error",
                "symlink",
                Some(path.clone()),
                "包内不允许符号链接".to_string(),
            ));
            continue;
        }
        if !metadata.is_file() {
            issues.push(issue(
                "error",
                "not_a_file",
                Some(path.clone()),
                "integrity 声明的路径不是普通文件".to_string(),
            ));
            continue;
        }
        total_bytes += metadata.len();
        let actual = hash_file(&absolute)?;
        if actual != expected.to_ascii_lowercase() {
            issues.push(issue(
                "error",
                "hash_mismatch",
                Some(path.clone()),
                format!("内容 hash 不符：期望 {expected}，实际 {actual}"),
            ));
        }
    }

    collect_unlisted(&root, &root, &known, &mut issues)?;

    let restorable = !issues.iter().any(|item| item.severity == "error");
    Ok(InspectReport {
        directory: root.to_string_lossy().to_string(),
        format,
        format_version,
        exported_at,
        vault_name,
        include_workbench,
        documents: documents_count,
        assets: assets_count,
        workbench_files: workbench_count,
        total_bytes,
        restorable,
        issues,
    })
}

fn collect_unlisted(
    root: &Path,
    dir: &Path,
    known: &HashSet<String>,
    issues: &mut Vec<BackupIssue>,
) -> VaultResult<()> {
    let listing = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(error, dir)),
    };
    for item in listing {
        let item = item?;
        let file_type = item.file_type()?;
        let path = item.path();
        if file_type.is_symlink() {
            issues.push(issue(
                "error",
                "symlink",
                Some(relative_posix(root, &path)),
                "包内不允许符号链接".to_string(),
            ));
            continue;
        }
        if file_type.is_dir() {
            collect_unlisted(root, &path, known, issues)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let relative = relative_posix(root, &path);
        if relative == MANIFEST || known.contains(&relative) {
            continue;
        }
        issues.push(issue(
            "warn",
            "unlisted_file",
            Some(relative),
            "文件未登记在 integrity 中，恢复时会被忽略".to_string(),
        ));
    }
    Ok(())
}

fn check_duplicate_paths(declared: &[String], issues: &mut Vec<BackupIssue>) {
    let mut exact: HashSet<&str> = HashSet::new();
    let mut folded: HashMap<String, &str> = HashMap::new();
    for path in declared {
        if !exact.insert(path.as_str()) {
            issues.push(issue(
                "conflict",
                "duplicate_path",
                Some(path.clone()),
                "同一路径在清单中重复出现".to_string(),
            ));
            continue;
        }
        let key = path.to_lowercase();
        if let Some(other) = folded.get(&key) {
            if *other != path.as_str() {
                issues.push(issue(
                    "conflict",
                    "case_collision",
                    Some(path.clone()),
                    format!("与「{other}」仅大小写不同，大小写不敏感磁盘上会互相覆盖"),
                ));
            }
        } else {
            folded.insert(key, path.as_str());
        }
    }
}

/// 包内相对路径约束：普通段、限定顶层目录、拒绝 `..` 与反斜杠。
fn validate_export_path(path: &str, include_workbench: bool) -> Result<(), (&'static str, String)> {
    if path.is_empty() {
        return Err(("invalid_path", "路径为空".to_string()));
    }
    if path.contains('\\') {
        return Err(("invalid_path", "路径包含反斜杠".to_string()));
    }
    if path.starts_with('/') {
        return Err(("invalid_path", "路径不得是绝对路径".to_string()));
    }
    let segments: Vec<&str> = path.split('/').collect();
    for segment in &segments {
        if segment.is_empty() {
            return Err(("invalid_path", "路径包含空段".to_string()));
        }
        if *segment == "." || *segment == ".." {
            return Err((
                "path_traversal",
                format!("路径包含越界段「{segment}」"),
            ));
        }
    }
    match segments[0] {
        DOCS_PREFIX | ASSETS_PREFIX => Ok(()),
        ".workbench" => {
            if !include_workbench {
                Err((
                    "workbench_excluded",
                    "该包声明不含 workbench，却出现 .workbench/ 文件".to_string(),
                ))
            } else if segments.len() < 2 {
                Err(("invalid_path", ".workbench 下缺少文件名".to_string()))
            } else {
                Ok(())
            }
        }
        other => Err((
            "invalid_path",
            format!("未知的顶层目录「{other}」，只接受 docs/、assets/ 与 .workbench/"),
        )),
    }
}

fn join_export(root: &Path, relative: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in relative.split('/') {
        path.push(segment);
    }
    path
}

fn path_segments(relative: &str) -> PathBuf {
    let mut path = PathBuf::new();
    for segment in relative.split('/') {
        path.push(segment);
    }
    path
}

fn relative_posix(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().to_string())
}

struct Copied {
    size: u64,
    hash: String,
}

/// 单次读源：边写边算 sha256；写完 fsync，保证 staging 内容真正落盘。
fn copy_hashed(source: &Path, target: &Path) -> VaultResult<Copied> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| io_at(error, parent))?;
    }
    let mut reader = File::open(source).map_err(|error| io_at(error, source))?;
    let mut writer = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .map_err(|error| io_at(error, target))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    let mut size = 0u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|error| io_at(error, source))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        writer
            .write_all(&buffer[..read])
            .map_err(|error| io_at(error, target))?;
        size += read as u64;
    }
    writer.sync_all().map_err(|error| io_at(error, target))?;
    Ok(Copied {
        size,
        hash: to_hex(&hasher.finalize()),
    })
}

fn verify_source_unchanged(source: &Path, expected: &str) -> VaultResult<()> {
    let actual = hash_file(source)?;
    if actual != expected {
        return Err(VaultError::Encoding(format!(
            "导出期间源文件发生变化，已中止：{}",
            source.display()
        )));
    }
    Ok(())
}

fn hash_file(path: &Path) -> VaultResult<String> {
    let mut file = File::open(path).map_err(|error| io_at(error, path))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; COPY_BUFFER];
    loop {
        let read = file.read(&mut buffer).map_err(|error| io_at(error, path))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(to_hex(&hasher.finalize()))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn issue(
    severity: &'static str,
    code: &'static str,
    path: Option<String>,
    message: String,
) -> BackupIssue {
    BackupIssue {
        severity,
        code,
        path,
        message,
    }
}

fn io_at(error: std::io::Error, path: &Path) -> VaultError {
    VaultError::IoAt {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}

fn symlink_error(path: &Path) -> VaultError {
    VaultError::PathOutside(format!("导出拒绝符号链接：{}", path.display()))
}

fn staging_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let seq = STAGING_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos}-{seq}")
}

fn vault_name(vault: &Vault) -> String {
    if let Ok(Some(bytes)) = vault.read(".workbench/settings.json") {
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if let Some(name) = value.pointer("/vault/name").and_then(Value::as_str) {
                if !name.trim().is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    vault
        .root()
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Ember Vault".to_string())
}

/// 目录名只允许普通字符：库名里的 `/`、`:` 会让默认导出路径变成两级目录。
fn safe_name(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch == '/' || ch == '\\' || ch == ':' || ch == '*' || ch == '?' || ch.is_control() {
                '-'
            } else {
                ch
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    let clipped: String = trimmed.chars().take(60).collect();
    if clipped.is_empty() {
        "Vault".to_string()
    } else {
        clipped
    }
}

#[derive(Default)]
struct DocMeta {
    id: Option<String>,
    title: Option<String>,
    tags: Vec<String>,
    aliases: Vec<String>,
}

/// 只读 frontmatter 的前 256 KiB；非 UTF-8 或没有 frontmatter 时返回空元数据。
fn read_doc_meta(path: &Path) -> DocMeta {
    let file = match File::open(path) {
        Ok(value) => value,
        Err(_) => return DocMeta::default(),
    };
    let mut buffer = Vec::new();
    if file
        .take(MAX_FRONTMATTER_BYTES)
        .read_to_end(&mut buffer)
        .is_err()
    {
        return DocMeta::default();
    }
    match std::str::from_utf8(&buffer) {
        Ok(text) => parse_doc_meta(text),
        Err(_) => DocMeta::default(),
    }
}

fn parse_doc_meta(text: &str) -> DocMeta {
    let body = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(rest) = body.strip_prefix("---") else {
        return DocMeta::default();
    };
    let Some(rest) = rest
        .strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
    else {
        return DocMeta::default();
    };
    let mut meta = DocMeta::default();
    let mut pending: Option<&str> = None;
    for raw in rest.lines() {
        let line = raw.trim_end_matches('\r');
        if line.trim_start().starts_with("---") {
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with(' ') || line.starts_with('\t') {
            let item = line.trim_start();
            if let (Some(key), Some(value)) = (pending, item.strip_prefix('-')) {
                let value = yaml_scalar(value);
                if !value.is_empty() {
                    push_meta_value(&mut meta, key, value);
                }
            }
            continue;
        }
        pending = None;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if !matches!(key, "id" | "title" | "tags" | "aliases") {
            continue;
        }
        let value = value.trim();
        if value.is_empty() {
            pending = Some(key);
            continue;
        }
        if key == "tags" || key == "aliases" {
            let list = inline_list(value);
            if list.is_empty() {
                pending = Some(key);
            } else {
                for item in list {
                    push_meta_value(&mut meta, key, item);
                }
            }
            continue;
        }
        let scalar = yaml_scalar(value);
        if scalar.is_empty() {
            continue;
        }
        if key == "id" {
            meta.id = Some(scalar);
        } else {
            meta.title = Some(scalar);
        }
    }
    meta
}

fn push_meta_value(meta: &mut DocMeta, key: &str, value: String) {
    if key == "tags" {
        meta.tags.push(value);
    } else {
        meta.aliases.push(value);
    }
}

fn yaml_scalar(value: &str) -> String {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .unwrap_or(value);
    let value = value
        .strip_prefix('\'')
        .and_then(|inner| inner.strip_suffix('\''))
        .unwrap_or(value);
    value.trim().to_string()
}

fn inline_list(value: &str) -> Vec<String> {
    let value = value.trim();
    if !(value.starts_with('[') && value.ends_with(']')) {
        return Vec::new();
    }
    value[1..value.len() - 1]
        .split(',')
        .map(yaml_scalar)
        .filter(|item| !item.is_empty())
        .collect()
}

fn file_stem(path: &str) -> Option<String> {
    let name = path.rsplit('/').next()?;
    let stem = name.strip_suffix(".md").unwrap_or(name);
    if stem.is_empty() {
        None
    } else {
        Some(stem.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempVault {
        vault: Vault,
        root: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            let root = temp_dir("ember-backup-vault");
            let vault = Vault::open(root.clone()).unwrap();
            Self { vault, root }
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{label}-{}-{nanos}-{seq}", std::process::id()))
    }

    const DOC: &str = "---\nid: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2\ntitle: 方案\ntags: [研发, 架构]\naliases: [plan]\n---\n\n# 方案\n";

    fn write_asset(root: &Path, hash: &str) -> PathBuf {
        let dir = root.join("media").join(&hash[..2]);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("{hash}.png"));
        fs::write(&file, b"fake-png-bytes").unwrap();
        file
    }

    fn export_to(temp: &TempVault, include_workbench: bool) -> (PathBuf, ExportReport) {
        let dest = temp_dir("ember-export-out");
        let report = export(
            &temp.vault,
            &ExportOptions {
                destination: dest.to_string_lossy().to_string(),
                include_workbench,
            },
        )
        .unwrap();
        (dest, report)
    }

    #[test]
    fn export_roundtrip_keeps_mapping_and_integrity() {
        let temp = TempVault::new();
        temp.vault.write("notes/方案.md", DOC.as_bytes(), "user").unwrap();
        let asset = write_asset(&temp.root, &"ab".repeat(32));
        fs::create_dir_all(temp.root.join(".workbench/canvas")).unwrap();
        fs::write(temp.root.join(".workbench/canvas/01JCANVAS.json"), b"{}").unwrap();
        fs::create_dir_all(temp.root.join(".workbench/history")).unwrap();
        fs::write(temp.root.join(".workbench/history/01JCANVAS.1.json"), b"{}").unwrap();
        fs::create_dir_all(temp.root.join(".workbench/trash/01JOLD")).unwrap();
        fs::write(temp.root.join(".workbench/trash/01JOLD/x.md"), b"old").unwrap();

        let (dest, report) = export_to(&temp, true);

        assert_eq!(report.documents, 1);
        assert_eq!(report.assets, 1);
        // settings + canvas + history
        assert_eq!(report.workbench_files, 3);
        assert!(dest.join("docs/notes/方案.md").exists());
        assert!(dest.join("assets/ab").join(format!("{}.png", "ab".repeat(32))).exists());
        assert!(dest.join(".workbench/settings.json").exists());
        assert!(dest.join(".workbench/canvas/01JCANVAS.json").exists());
        assert!(dest.join(".workbench/history/01JCANVAS.1.json").exists());
        assert!(!dest.join(".workbench/.lock").exists(), "锁不得进包");
        assert!(!dest.join(".workbench/trash").exists(), "旧回收目录不得进包");
        assert!(asset.exists(), "导出不得移动源文件");

        let manifest: Value =
            serde_json::from_slice(&fs::read(dest.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["format"], FORMAT);
        assert_eq!(manifest["formatVersion"], FORMAT_VERSION);
        assert_eq!(manifest["documents"][0]["id"], "01JB8ZQ3K4M5N6P7Q8R9S0T1V2");
        assert_eq!(manifest["documents"][0]["title"], "方案");
        assert_eq!(manifest["documents"][0]["tags"][0], "研发");
        assert_eq!(manifest["workbench"]["canvas"][0], "01JCANVAS");
        let expected = hash_file(&temp.root.join("notes/方案.md")).unwrap();
        assert_eq!(manifest["integrity"]["files"]["docs/notes/方案.md"], expected);
        assert_eq!(
            manifest["documents"][0]["contentHash"],
            format!("sha256:{expected}")
        );

        let report = inspect(dest.to_str().unwrap()).unwrap();
        assert!(report.restorable, "刚导出的包应可恢复：{:?}", report.issues);
        assert_eq!(report.documents, 1);
        assert_eq!(report.assets, 1);
        assert_eq!(report.workbench_files, 3);
    }

    #[test]
    fn export_includes_nested_document_history() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let history = temp.root.join(".workbench/history/documents/01JDOC");
        fs::create_dir_all(&history).unwrap();
        fs::write(history.join("index.json"), br#"{"schemaVersion":1}"#).unwrap();
        fs::write(history.join("01JVERSION.md"), b"old body").unwrap();
        fs::write(history.join(".ember-tmp-ignored"), b"tmp").unwrap();

        let (dest, report) = export_to(&temp, true);

        assert!(report.workbench_files >= 2, "settings + 文档历史应进包");
        assert!(dest.join(".workbench/history/documents/01JDOC/index.json").exists());
        assert!(dest.join(".workbench/history/documents/01JDOC/01JVERSION.md").exists());
        assert!(!dest.join(".workbench/history/documents/01JDOC/.ember-tmp-ignored").exists());
        assert!(inspect(dest.to_str().unwrap()).unwrap().restorable);
    }

    #[test]
    fn export_can_skip_workbench() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();

        let (dest, report) = export_to(&temp, false);

        assert_eq!(report.workbench_files, 0);
        assert!(!dest.join(".workbench").exists());
    }

    #[test]
    fn export_refuses_existing_target() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let dest = temp_dir("ember-export-exists");
        fs::create_dir_all(&dest).unwrap();

        let error = export(
            &temp.vault,
            &ExportOptions {
                destination: dest.to_string_lossy().to_string(),
                include_workbench: true,
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "path_exists");
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn export_refuses_target_inside_vault() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let dest = temp.root.join("exported");

        let error = export(
            &temp.vault,
            &ExportOptions {
                destination: dest.to_string_lossy().to_string(),
                include_workbench: true,
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "path_outside_vault");
        assert!(!dest.exists());
    }

    #[test]
    fn export_refuses_symlink_inside_vault() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let outside = temp_dir("ember-backup-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, temp.root.join("notes/escape")).unwrap();

        let dest = temp_dir("ember-export-symlink");
        let error = export(
            &temp.vault,
            &ExportOptions {
                destination: dest.to_string_lossy().to_string(),
                include_workbench: true,
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), "path_outside_vault");
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn inspect_flags_tampered_bytes() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let (dest, _) = export_to(&temp, true);

        fs::write(dest.join("docs/notes/a.md"), b"tampered").unwrap();
        let report = inspect(dest.to_str().unwrap()).unwrap();

        assert!(!report.restorable);
        assert!(
            report
                .issues
                .iter()
                .any(|item| item.code == "hash_mismatch" && item.severity == "error"),
            "应报告 hash 不符：{:?}",
            report.issues
        );
    }

    #[test]
    fn inspect_rejects_path_traversal_and_unknown_roots() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let (dest, _) = export_to(&temp, true);

        let manifest_path = dest.join(MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let files = manifest["integrity"]["files"].as_object_mut().unwrap();
        files.insert("../evil.md".to_string(), json!("00"));
        files.insert("secrets/x.md".to_string(), json!("00"));
        fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();

        let report = inspect(dest.to_str().unwrap()).unwrap();
        assert!(!report.restorable);
        assert!(report.issues.iter().any(|item| item.code == "path_traversal"));
        assert!(report
            .issues
            .iter()
            .any(|item| item.code == "invalid_path" && item.message.contains("未知的顶层目录")));
    }

    #[test]
    fn inspect_flags_duplicate_ids_and_case_collisions() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        temp.vault.write("notes/b.md", DOC.as_bytes(), "user").unwrap();
        let (dest, _) = export_to(&temp, true);

        let manifest_path = dest.join(MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        let docs = manifest["documents"].as_array_mut().unwrap();
        let first_id = docs[0]["id"].clone();
        docs[1]["id"] = first_id;
        docs[1]["path"] = json!("docs/Notes/A.md");
        fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();

        let report = inspect(dest.to_str().unwrap()).unwrap();
        assert!(report.issues.iter().any(|item| item.code == "duplicate_id"));
        assert!(report.issues.iter().any(|item| item.code == "case_collision"));
        assert!(report.restorable, "冲突不算致命错误：{:?}", report.issues);
    }

    #[test]
    fn inspect_reports_unsupported_version() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let (dest, _) = export_to(&temp, true);
        let manifest_path = dest.join(MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest["formatVersion"] = json!(99);
        fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();

        let report = inspect(dest.to_str().unwrap()).unwrap();
        assert!(!report.restorable);
        assert!(report
            .issues
            .iter()
            .any(|item| item.code == "unsupported_version"));
    }

    #[test]
    fn detects_source_change_between_copy_and_verify() {
        let dir = temp_dir("ember-backup-concurrent");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("a.md");
        fs::write(&source, b"first").unwrap();
        let copied = copy_hashed(&source, &dir.join("copy.md")).unwrap();
        verify_source_unchanged(&source, &copied.hash).unwrap();

        fs::write(&source, b"second").unwrap();
        let error = verify_source_unchanged(&source, &copied.hash).unwrap_err();
        assert_eq!(error.code(), "invalid_payload");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn failed_export_leaves_no_staging_directory() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TempVault::new();
        temp.vault.write("notes/a.md", DOC.as_bytes(), "user").unwrap();
        let locked = temp.root.join("notes/z-locked.md");
        fs::write(&locked, DOC.as_bytes()).unwrap();
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&locked).is_ok() {
            // root 下权限位不生效，跳过该场景而不是给出假结论
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
            return;
        }

        let parent = temp_dir("ember-export-parent");
        fs::create_dir_all(&parent).unwrap();
        let dest = parent.join("pkg");
        let result = export(
            &temp.vault,
            &ExportOptions {
                destination: dest.to_string_lossy().to_string(),
                include_workbench: true,
            },
        );
        let error = result.unwrap_err();
        assert_eq!(error.code(), "io_failed");
        assert!(!dest.exists(), "失败的导出不得留下最终目录");
        let residue = fs::read_dir(&parent)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|item| {
                item.file_name()
                    .to_string_lossy()
                    .contains(".ember-export-staging-")
            })
            .count();
        assert_eq!(residue, 0, "失败的导出不得留下 staging 残包");

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o644)).unwrap();
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn inspect_rejects_missing_manifest() {
        let dir = temp_dir("ember-backup-empty");
        fs::create_dir_all(&dir).unwrap();
        let error = inspect(dir.to_str().unwrap()).unwrap_err();
        assert_eq!(error.code(), "doc_not_found");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn doc_meta_parses_inline_and_block_lists() {
        let text = "---\nid: 01JB8ZQ3K4M5N6P7Q8R9S0T1V2\ntitle: \"方案 A\"\ntags:\n  - 研发\n  - 架构\naliases: [plan, '技术方案']\n---\n正文";
        let meta = parse_doc_meta(text);
        assert_eq!(meta.id.as_deref(), Some("01JB8ZQ3K4M5N6P7Q8R9S0T1V2"));
        assert_eq!(meta.title.as_deref(), Some("方案 A"));
        assert_eq!(meta.tags, vec!["研发".to_string(), "架构".to_string()]);
        assert_eq!(meta.aliases, vec!["plan".to_string(), "技术方案".to_string()]);
    }
}
