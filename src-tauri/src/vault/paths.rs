use std::fs;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{VaultError, VaultResult};

/// 把前端传来的 vault 相对路径解析成绝对路径。
/// 只接受普通段，拒绝绝对路径、`..`、盘符与反斜杠，保证不会越出库根。
/// 同时逐段探测已存在的前缀：任何一级是符号链接即拒绝（库内被拖入外部链接时，
/// 词法检查不再足以保证不越出库根；read/write 会跟随链接语义）。
pub fn resolve(root: &Path, relative: &str) -> VaultResult<(PathBuf, String)> {
    if relative.is_empty() {
        return Err(VaultError::PathOutside("空路径".to_string()));
    }
    if relative.contains('\\') {
        return Err(VaultError::PathOutside(relative.to_string()));
    }

    let mut normalized: Vec<String> = Vec::new();
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(segment) => {
                let text = segment.to_string_lossy().to_string();
                if text.is_empty() || text == "." {
                    continue;
                }
                normalized.push(text);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(VaultError::PathOutside(relative.to_string()));
            }
        }
    }

    if normalized.is_empty() {
        return Err(VaultError::PathOutside(relative.to_string()));
    }

    let mut absolute = root.to_path_buf();
    for segment in &normalized {
        absolute.push(segment);
    }

    // 符号链接前缀探测用独立探针：即使中途发现不存在而停止，
    // 也不能影响 absolute 的完整拼装。
    let mut probe = root.to_path_buf();
    for segment in &normalized {
        probe.push(segment);
        // 一旦某段不存在，更深处也不可能存在（POSIX 语义），无需继续探测。
        match fs::symlink_metadata(&probe) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(VaultError::PathOutside(relative.to_string()));
                }
            }
            Err(_) => break,
        }
    }
    Ok((absolute, normalized.join("/")))
}

/// 库内保留目录：内核知识目录，不参与文档扫描。
pub const WORKBENCH_DIR: &str = ".workbench";

pub fn workbench(root: &Path) -> PathBuf {
    root.join(WORKBENCH_DIR)
}

/// 规范化根路径文本：能解析就解析（软链、`..`、尾斜杠），失败退回字面值。
/// 库外状态的键、锁的键都以它为准，保证同一库的不同写法落到同一条记录。
pub fn normalized_root(root: &Path) -> String {
    let resolved = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let text = resolved.to_string_lossy().to_string();
    text.trim_end_matches('/').to_string()
}

pub fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 库外状态的键（D7）：`settings.json` 的 `vault.id` 是合法 ULID 时优先用
/// 它，否则派生自规范化根路径。首次确认建库时 `vault.id` 刚写入，
/// 键会从派生值切到 ULID 一次——这是已知且接受的迁移点。
pub fn vault_key(root: &Path) -> String {
    if let Ok(text) = fs::read_to_string(settings_file(root)) {
        if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(serde_json::Value::Object(vault)) = map.get("vault") {
                if let Some(serde_json::Value::String(id)) = vault.get("id") {
                    if crate::vault::ulid::is_ulid(id) {
                        return id.clone();
                    }
                }
            }
        }
    }
    derived_key(root)
}

/// 仅由根路径派生（不看 settings）：建库前必须稳定，首次建库不会漂移。
pub fn derived_key(root: &Path) -> String {
    sha256_hex(&normalized_root(root))
}

/// 库外状态根：`~/Library/Application Support/Ember/vaults/<key>/`。
/// 迁移快照与新历史日志都落在这里，绝不写进库内（可能位于 iCloud）。
pub fn vault_state_dir(root: &Path) -> PathBuf {
    app_support_dir().join("vaults").join(vault_key(root))
}

/// 库锁目录：`~/Library/Application Support/Ember/locks/<hash(root)>/`。
/// 锁在建库前就要存在，且不能随 `vault.id` 出现而变化，因此只用根路径派生。
pub fn lock_dir(root: &Path) -> PathBuf {
    app_support_dir().join("locks").join(derived_key(root))
}

pub fn lock_file(root: &Path) -> PathBuf {
    lock_dir(root).join("lock")
}

pub fn settings_file(root: &Path) -> PathBuf {
    workbench(root).join("settings.json")
}

/// 图库内容寻址存储（库根 `media/`），只能经 `asset_save` 写入。
pub const MEDIA_DIR: &str = "media";

/// 内核自管路径黑名单：前端 IPC（vault_write/remove/rename）不得触碰。
/// 黑名单依据：`.lock` 被删可让另一实例按失效锁接管形成双写者；`.ember-tmp-` 是
/// 原子写临时文件的命名约定；`media/` 内容按哈希去重，外部写入会毒化附件库。
/// settings.json、canvas 等仍是前端合法写入目标，不在名单内。
/// 入参必须是 `resolve` 归一化后的相对 POSIX 路径。
/// 比较不区分大小写：macOS APFS 默认大小写不敏感，`.Workbench/` 与
/// `.workbench/` 在磁盘上是同一个文件，字面比较会被变体击穿。
/// 副作用是大小写敏感文件系统上 `Media/`、`WORKBENCH/` 这类用户目录也被禁写——
/// 宁可保守，避免与内核自管路径在同一卷上产生二义。
pub fn is_reserved(normalized: &str) -> bool {
    let folded = normalized.to_ascii_lowercase();
    if folded == WORKBENCH_DIR || folded == ".workbench/.lock" {
        return true;
    }
    if folded == MEDIA_DIR || folded.starts_with("media/") {
        return true;
    }
    let file = folded.rsplit('/').next().unwrap_or(folded.as_str());
    file.contains(".ember-tmp-")
}

pub fn ensure_not_reserved(normalized: &str) -> VaultResult<()> {
    if is_reserved(normalized) {
        return Err(VaultError::PathOutside(format!(
            "保留路径禁止改动（内核自管文件）：{normalized}"
        )));
    }
    Ok(())
}

/// 应用级状态目录：`~/Library/Application Support/Ember`。
pub fn app_support_dir() -> PathBuf {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Ember"),
        _ => std::env::temp_dir().join("Ember"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_paths_are_rejected() {
        for path in [
            ".workbench",
            ".workbench/.lock",
            "media",
            "media/ab/01J.json.png",
            ".doc.md.ember-tmp-1731234567-1",
            "notes/.hidden.md.ember-tmp-9-2",
        ] {
            assert!(is_reserved(path), "应命中黑名单：{path}");
            assert!(ensure_not_reserved(path).is_err());
        }
    }

    #[test]
    fn reserved_paths_rejected_case_insensitively() {
        // macOS APFS 默认大小写不敏感：字面变体在磁盘上是同一个文件，必须同黑名单拦截。
        for path in [
            ".WORKBENCH",
            ".Workbench/.LOCK",
            "Media",
            "MEDIA/ab/01J.json.png",
            "notes/.Hidden.md.ember-tmp-1",
        ] {
            assert!(is_reserved(path), "大小写变体应命中黑名单：{path}");
            assert!(ensure_not_reserved(path).is_err());
        }
    }

    #[test]
    fn legitimate_workbench_paths_pass() {
        for path in [
            "notes/a.md",
            ".workbench/settings.json",
            ".workbench/canvas/01J.json",
            ".workbench/trash/01J/a.md",
            ".workbench/ui.json",
            ".workbench/.locknote.md",
            "media-notes/a.md",
        ] {
            assert!(!is_reserved(path), "不应命中黑名单：{path}");
            assert!(ensure_not_reserved(path).is_ok());
        }
    }

    #[test]
    fn resolve_normalizes_before_matching() {
        // `.` 与重复分隔符在 resolve 中被折叠，归一化后再比对黑名单。
        let (absolute, normalized) = resolve(Path::new("/tmp/v"), "./.workbench/./.lock").unwrap();
        assert_eq!(normalized, ".workbench/.lock");
        assert!(is_reserved(&normalized));
        assert!(absolute.ends_with(".workbench/.lock"));
    }
}
