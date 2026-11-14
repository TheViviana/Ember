use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::VaultResult;
use crate::vault::{atomic, clock, paths};

/// 库外配置版本：只描述 `vaults.json` 自身结构，与库内 `.workbench` schema 无关。
const CONFIG_SCHEMA_VERSION: u64 = 1;

/// 最近库上限：仅用于快速切回，不承担历史记录职责。
const MAX_RECENTS: usize = 10;

/// 一个最近打开过的库。`vaultId` 尽力记录（打开成功才有），`openedAt` 为 ISO8601。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecentVault {
    pub path: String,
    #[serde(rename = "vaultId", skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(rename = "openedAt")]
    pub opened_at: String,
}

/// `~/Library/Application Support/Ember/vaults.json` 的结构。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultsConfig {
    pub schema_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_root: Option<String>,
    #[serde(default)]
    pub recents: Vec<RecentVault>,
}

impl Default for VaultsConfig {
    fn default() -> Self {
        Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            last_root: None,
            recents: Vec::new(),
        }
    }
}

pub fn config_file() -> PathBuf {
    paths::app_support_dir().join("vaults.json")
}

/// 读取配置。文件缺失、损坏或 schemaVersion 不受支持时返回空配置，
/// 并附带一条告警；不删除、不改写磁盘上的原文件。
pub fn load() -> (VaultsConfig, Option<String>) {
    load_at(&config_file())
}

pub fn load_at(file: &Path) -> (VaultsConfig, Option<String>) {
    let text = match fs::read_to_string(file) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return (VaultsConfig::default(), None);
        }
        Err(error) => {
            return (
                VaultsConfig::default(),
                Some(format!("读取库配置失败（{}）：{error}", file.display())),
            );
        }
    };
    let config = match serde_json::from_str::<VaultsConfig>(&text) {
        Ok(value) if value.schema_version == CONFIG_SCHEMA_VERSION => value,
        Ok(value) => {
            return (
                VaultsConfig::default(),
                Some(format!(
                    "库配置 schemaVersion={}，当前应用只支持 {CONFIG_SCHEMA_VERSION}：{}",
                    value.schema_version,
                    file.display()
                )),
            );
        }
        Err(error) => {
            return (
                VaultsConfig::default(),
                Some(format!("库配置无法解析（{}）：{error}", file.display())),
            );
        }
    };
    (config, None)
}

/// 记录一次成功打开：更新 `lastRoot`，把该路径置顶到最近列表并截断。
/// 比较与写入都用规范化路径（解析软链、去尾斜杠），同一库只有一条记录。
///
/// 返回需要在界面上提示的告警：原配置无法识别时会先备份再覆盖。
pub fn record_open(root: &Path, vault_id: &str) -> VaultResult<Option<String>> {
    record_open_at(&config_file(), root, vault_id)
}

pub fn record_open_at(file: &Path, root: &Path, vault_id: &str) -> VaultResult<Option<String>> {
    let (mut config, warning) = load_at(file);
    // 降级运行（配置来自更高版本或已损坏）时不得静默覆盖：先留一份原文件。
    let notice = if warning.is_some() && fs::read(file).is_ok() {
        let backup = backup_config(file)?;
        Some(format!(
            "原有库配置无法识别，已备份到 {} 并写入新配置。",
            backup.display()
        ))
    } else {
        None
    };

    let path = normalized_path(root);
    config.last_root = Some(path.clone());
    config
        .recents
        .retain(|entry| normalized_path(Path::new(&entry.path)) != path);
    config.recents.insert(
        0,
        RecentVault {
            path,
            vault_id: Some(vault_id.to_string()),
            opened_at: clock::now_iso8601(),
        },
    );
    config.recents.truncate(MAX_RECENTS);
    config.schema_version = CONFIG_SCHEMA_VERSION;

    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    atomic::write_atomic(file, &serde_json::to_vec_pretty(&config)?)?;
    Ok(notice)
}

/// 规范化路径用于去重：能解析就解析（软链、`..`、尾斜杠），不能解析时
/// 退回去掉尾斜杠的字面值——删掉目录后 recents 里的旧条目仍然可比。
fn normalized_path(path: &Path) -> String {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let text = resolved.to_string_lossy().to_string();
    text.trim_end_matches('/').to_string()
}

/// 覆盖无法识别/损坏的配置前留一份副本（固定 `vaults.json.bak`，只保留最近一份）。
fn backup_config(file: &Path) -> std::io::Result<PathBuf> {
    let mut name = file.as_os_str().to_owned();
    name.push(".bak");
    let backup = PathBuf::from(name);
    fs::copy(file, &backup)?;
    Ok(backup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default();
            let dir = std::env::temp_dir().join(format!(
                "ember-config-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join("vaults.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_is_empty_config_without_warning() {
        let temp = TempDir::new("missing");
        let (config, warning) = load_at(&temp.file());
        assert_eq!(config, VaultsConfig::default());
        assert!(warning.is_none());
        assert!(!temp.file().exists(), "读取不得创建配置文件");
    }

    #[test]
    fn unsupported_version_is_ignored_and_file_untouched() {
        let temp = TempDir::new("future");
        let raw = br#"{"schemaVersion":99,"lastRoot":"/future","recents":[]}"#;
        fs::write(temp.file(), raw).unwrap();

        let (config, warning) = load_at(&temp.file());
        assert_eq!(config, VaultsConfig::default());
        assert!(warning.is_some());
        assert_eq!(fs::read(temp.file()).unwrap(), raw, "不得改写不认识的配置");
    }

    #[test]
    fn corrupt_json_is_ignored_and_file_untouched() {
        let temp = TempDir::new("corrupt");
        fs::write(temp.file(), b"not-json").unwrap();
        let (config, warning) = load_at(&temp.file());
        assert_eq!(config, VaultsConfig::default());
        assert!(warning.is_some());
        assert_eq!(fs::read(temp.file()).unwrap(), b"not-json");
    }

    #[test]
    fn record_open_moves_path_to_front_and_updates_last_root() {
        let temp = TempDir::new("record");
        let file = temp.file();
        record_open_at(&file, Path::new("/vaults/a"), "01JA").unwrap();
        record_open_at(&file, Path::new("/vaults/b"), "01JB").unwrap();
        record_open_at(&file, Path::new("/vaults/a"), "01JA").unwrap();

        let (config, warning) = load_at(&file);
        assert!(warning.is_none());
        assert_eq!(config.last_root.as_deref(), Some("/vaults/a"));
        assert_eq!(
            config
                .recents
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            vec!["/vaults/a", "/vaults/b"]
        );
        assert_eq!(config.recents[0].vault_id.as_deref(), Some("01JA"));
        assert!(!config.recents[0].opened_at.is_empty());
    }

    #[test]
    fn recents_are_capped() {
        let temp = TempDir::new("cap");
        let file = temp.file();
        for index in 0..(MAX_RECENTS + 3) {
            record_open_at(&file, Path::new(&format!("/vaults/{index}")), "01J").unwrap();
        }
        let (config, _) = load_at(&file);
        assert_eq!(config.recents.len(), MAX_RECENTS);
        assert_eq!(
            config.recents[0].path,
            format!("/vaults/{}", MAX_RECENTS + 2)
        );
    }

    #[test]
    fn same_vault_with_trailing_slash_is_one_recent_entry() {
        let temp = TempDir::new("dedupe-slash");
        let file = temp.file();
        let root = temp.0.join("vault");
        fs::create_dir_all(&root).unwrap();

        record_open_at(&file, &root, "01JA").unwrap();
        let with_slash = format!("{}/", root.to_string_lossy());
        record_open_at(&file, Path::new(&with_slash), "01JA").unwrap();

        let (config, _) = load_at(&file);
        assert_eq!(config.recents.len(), 1, "尾斜杠不得生成第二条记录");
        assert_eq!(
            config.last_root.as_deref(),
            Some(config.recents[0].path.as_str())
        );
    }

    #[cfg(unix)]
    #[test]
    fn same_vault_through_symlink_is_one_recent_entry() {
        let temp = TempDir::new("dedupe-symlink");
        let file = temp.file();
        let root = temp.0.join("vault");
        let link = temp.0.join("alias");
        fs::create_dir_all(&root).unwrap();
        std::os::unix::fs::symlink(&root, &link).unwrap();

        record_open_at(&file, &root, "01JA").unwrap();
        record_open_at(&file, &link, "01JA").unwrap();

        let (config, _) = load_at(&file);
        assert_eq!(config.recents.len(), 1, "软链与实体目录是同一个库");
        assert_eq!(
            config.recents[0].path,
            root.canonicalize().unwrap().to_string_lossy().to_string()
        );
    }

    #[test]
    fn unknown_version_config_is_backed_up_before_overwrite() {
        let temp = TempDir::new("backup-version");
        let file = temp.file();
        let raw = br#"{"schemaVersion":99,"lastRoot":"/future","recents":[{"path":"/future","openedAt":"2026-01-01T00:00:00Z"}]}"#;
        fs::write(&file, raw).unwrap();

        let notice = record_open_at(&file, Path::new("/vaults/a"), "01JA")
            .unwrap()
            .expect("覆盖前应给出备份提示");
        assert!(notice.contains(".bak"), "提示应指明备份位置：{notice}");

        let backup = PathBuf::from(format!("{}.bak", file.to_string_lossy()));
        assert_eq!(fs::read(&backup).unwrap(), raw, "备份必须是原文件内容");

        let (config, warning) = load_at(&file);
        assert!(warning.is_none(), "改写后的配置应可正常读取");
        assert_eq!(config.schema_version, CONFIG_SCHEMA_VERSION);
        assert_eq!(config.last_root.as_deref(), Some("/vaults/a"));
    }

    #[test]
    fn corrupt_config_is_backed_up_before_overwrite() {
        let temp = TempDir::new("backup-corrupt");
        let file = temp.file();
        fs::write(&file, b"not-json").unwrap();

        record_open_at(&file, Path::new("/vaults/a"), "01JA")
            .unwrap()
            .expect("损坏配置也应先备份");
        let backup = PathBuf::from(format!("{}.bak", file.to_string_lossy()));
        assert_eq!(fs::read(&backup).unwrap(), b"not-json");
    }

    #[test]
    fn supported_config_is_not_backed_up() {
        let temp = TempDir::new("no-backup");
        let file = temp.file();
        record_open_at(&file, Path::new("/vaults/a"), "01JA").unwrap();
        assert!(record_open_at(&file, Path::new("/vaults/b"), "01JB")
            .unwrap()
            .is_none());
        assert!(!PathBuf::from(format!("{}.bak", file.to_string_lossy())).exists());
    }
}
