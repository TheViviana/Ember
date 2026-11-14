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
/// 同路径按字符串去重（同一库只保留最近一次），不追规范化软链。
pub fn record_open(root: &Path, vault_id: &str) -> VaultResult<()> {
    record_open_at(&config_file(), root, vault_id)
}

pub fn record_open_at(file: &Path, root: &Path, vault_id: &str) -> VaultResult<()> {
    let (mut config, _) = load_at(file);
    let path = root.to_string_lossy().to_string();
    config.last_root = Some(path.clone());
    config.recents.retain(|entry| entry.path != path);
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
    atomic::write_atomic(file, &serde_json::to_vec_pretty(&config)?)
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
}
