use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{VaultError, VaultResult};
use crate::vault::config::{self, RecentVault};
use crate::vault::lock::ReadonlyReason;
use crate::vault::watcher::{self, Watcher};
use crate::vault::Vault;

/// 打开方式：`Existing` 只接受已存在的库目录；`Create` 允许初始化（用户显式选择/新建）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    Existing,
    Create,
}

impl OpenMode {
    pub fn parse(raw: &str) -> VaultResult<Self> {
        match raw {
            "existing" => Ok(Self::Existing),
            "create" => Ok(Self::Create),
            other => Err(VaultError::Encoding(format!("未知的打开方式：{other}"))),
        }
    }
}

/// 启动解析所需的三个外部输入（测试直接构造，不依赖真实 HOME）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupInputs {
    pub env_root: Option<PathBuf>,
    pub config_root: Option<PathBuf>,
    pub legacy_root: Option<PathBuf>,
}

/// 解析顺序：`EMBER_VAULT` → `vaults.json.lastRoot` → 旧库（仅提示）→ 无。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupDecision {
    Open {
        root: PathBuf,
        mode: OpenMode,
        /// 环境变量覆盖不写库配置（开发/测试不应污染用户选择）
        persist: bool,
    },
    Choose {
        legacy_root: Option<PathBuf>,
    },
}

pub fn decide(inputs: &StartupInputs) -> StartupDecision {
    if let Some(root) = &inputs.env_root {
        return StartupDecision::Open {
            root: root.clone(),
            mode: OpenMode::Create,
            persist: false,
        };
    }
    if let Some(root) = &inputs.config_root {
        return StartupDecision::Open {
            root: root.clone(),
            mode: OpenMode::Existing,
            persist: true,
        };
    }
    StartupDecision::Choose {
        legacy_root: inputs.legacy_root.clone(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultIdentity {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub readonly: bool,
    /// 只读原因；可写时省略（additive 字段，老前端不受影响）
    #[serde(rename = "readonlyReason", skip_serializing_if = "Option::is_none")]
    pub readonly_reason: Option<ReadonlyReason>,
}

pub fn identity_of(vault: &Vault) -> VaultIdentity {
    VaultIdentity {
        vault_id: vault.id().to_string(),
        // 用 writable()：启动未抢到锁（被另一实例占用）的实例如实告知前端
        readonly: !vault.writable(),
        readonly_reason: vault.readonly_reason(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenFailure {
    pub root: Option<String>,
    pub code: String,
    pub message: String,
}

/// 前端启动闸门看到的三态。`tag = "status"` 让 TS 侧直接按 discriminated union 收窄。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum StartupView {
    Ready {
        identity: VaultIdentity,
        root: String,
    },
    Choose {
        #[serde(rename = "legacyRoot")]
        legacy_root: Option<String>,
        recents: Vec<RecentVault>,
        /// 配置损坏/版本过高时的告警；正常为 None
        warning: Option<String>,
    },
    Failed {
        root: Option<String>,
        code: String,
        message: String,
    },
}

#[derive(Debug, Serialize)]
pub struct VaultInfo {
    pub root: String,
    pub recents: Vec<RecentVault>,
}

/// 当前会话：库实例与 watcher 必须一起换，避免监听旧根。
pub struct Session {
    vault: Option<Vault>,
    watcher: Option<Watcher>,
    /// 仅记录启动阶段的打开失败；用户主动切换失败不写这里（当前库继续可用）
    failure: Option<OpenFailure>,
}

impl Session {
    pub fn vault(&self) -> VaultResult<&Vault> {
        self.vault.as_ref().ok_or(VaultError::Uninitialized)
    }
}

struct Candidate {
    root: PathBuf,
    mode: OpenMode,
    persist: bool,
}

/// 应用级库会话：启动解析、首启选择、运行期切换都经这里。
pub struct VaultApp {
    app: AppHandle,
    inner: Mutex<Session>,
    legacy_root: Option<PathBuf>,
    candidate: Option<Candidate>,
}

impl VaultApp {
    pub fn new(app: AppHandle) -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let legacy = PathBuf::from(&home).join("Documents").join("EmberVault");
        let legacy_root = legacy.is_dir().then_some(legacy);
        let env_root = std::env::var("EMBER_VAULT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let (settings, _) = config::load();
        let config_root = settings.last_root.as_ref().map(PathBuf::from);

        let candidate = match decide(&StartupInputs {
            env_root,
            config_root,
            legacy_root: legacy_root.clone(),
        }) {
            StartupDecision::Open {
                root,
                mode,
                persist,
            } => Some(Candidate {
                root,
                mode,
                persist,
            }),
            StartupDecision::Choose { .. } => None,
        };

        Self {
            app,
            inner: Mutex::new(Session {
                vault: None,
                watcher: None,
                failure: None,
            }),
            legacy_root,
            candidate,
        }
    }

    /// 启动时尝试一次；失败只记录，不 panic、不建死页。
    pub fn startup(&self) -> StartupView {
        if let Some(candidate) = &self.candidate {
            if let Err(failure) = self.apply_open(&candidate.root, candidate.mode, candidate.persist) {
                self.store_failure(failure);
            }
        }
        self.view()
    }

    /// 错误页「重试」：只重跑启动候选；首启选择阶段保持选择页。
    pub fn retry(&self) -> StartupView {
        if self.has_vault() {
            return self.view();
        }
        if let Some(candidate) = &self.candidate {
            match self.apply_open(&candidate.root, candidate.mode, candidate.persist) {
                Ok(()) => {
                    self.clear_failure();
                }
                Err(failure) => self.store_failure(failure),
            }
        }
        self.view()
    }

    /// 用户显式选择/新建/最近列表切换。失败时当前库保持不动。
    pub fn open_user(&self, root: &str, mode: &str) -> VaultResult<StartupView> {
        let mode = OpenMode::parse(mode)?;
        let trimmed = root.trim();
        if trimmed.is_empty() {
            return Err(VaultError::PathOutside("空目录路径".to_string()));
        }
        self.apply_open(Path::new(trimmed), mode, true)
            .map_err(|failure| VaultError::Startup(failure.message))?;
        Ok(self.view())
    }

    pub fn view(&self) -> StartupView {
        let session = match self.inner.lock() {
            Ok(value) => value,
            Err(_) => return self.poisoned_view(),
        };
        if let Some(vault) = &session.vault {
            return StartupView::Ready {
                identity: identity_of(vault),
                root: vault.root().to_string_lossy().to_string(),
            };
        }
        if let Some(failure) = &session.failure {
            return StartupView::Failed {
                root: failure.root.clone(),
                code: failure.code.clone(),
                message: failure.message.clone(),
            };
        }
        drop(session);

        let (settings, warning) = config::load();
        StartupView::Choose {
            legacy_root: self
                .legacy_root
                .as_ref()
                .map(|root| root.to_string_lossy().to_string()),
            recents: settings.recents,
            warning,
        }
    }

    pub fn info(&self) -> VaultResult<VaultInfo> {
        let session = self.session()?;
        let root = session
            .vault()?
            .root()
            .to_string_lossy()
            .to_string();
        drop(session);
        let (settings, _) = config::load();
        Ok(VaultInfo {
            root,
            recents: settings.recents,
        })
    }

    pub fn session(&self) -> VaultResult<MutexGuard<'_, Session>> {
        self.inner
            .lock()
            .map_err(|_| VaultError::Startup("库会话状态损坏".to_string()))
    }

    fn has_vault(&self) -> bool {
        self.inner
            .lock()
            .map(|session| session.vault.is_some())
            .unwrap_or(false)
    }

    fn poisoned_view(&self) -> StartupView {
        StartupView::Failed {
            root: None,
            code: "startup_failed".to_string(),
            message: "库会话状态损坏，请重启应用".to_string(),
        }
    }

    fn store_failure(&self, failure: OpenFailure) {
        if let Ok(mut session) = self.inner.lock() {
            session.failure = Some(failure);
        }
    }

    fn clear_failure(&self) {
        if let Ok(mut session) = self.inner.lock() {
            session.failure = None;
        }
    }

    /// 事务式打开：新库构建成功后才替换旧槽位；失败时旧库与旧 watcher 原样保留。
    fn apply_open(
        &self,
        root: &Path,
        mode: OpenMode,
        persist: bool,
    ) -> Result<(), OpenFailure> {
        let opened = match mode {
            OpenMode::Create => Vault::open_or_init(root.to_path_buf()),
            OpenMode::Existing => Vault::open_existing(root.to_path_buf()),
        };
        let vault = opened.map_err(|error| OpenFailure {
            root: Some(root.to_string_lossy().to_string()),
            code: error.code().to_string(),
            message: error.to_string(),
        })?;
        let identity = identity_of(&vault);
        let watcher = watcher::spawn(self.app.clone(), root.to_path_buf());

        {
            let mut session = self.inner.lock().map_err(|_| OpenFailure {
                root: Some(root.to_string_lossy().to_string()),
                code: "startup_failed".to_string(),
                message: "库会话状态损坏".to_string(),
            })?;
            let previous_vault = session.vault.replace(vault);
            let previous_watcher = session.watcher.replace(watcher);
            session.failure = None;
            drop(session);
            // Drop 在锁外：watcher 线程 join 与旧锁释放都不该阻塞其它 IPC。
            drop(previous_watcher);
            drop(previous_vault);
        }

        if persist {
            if let Err(error) = config::record_open(root, &identity.vault_id) {
                // 配置落盘失败不影响本次使用，但不能静默：用户下次启动会回到旧库。
                eprintln!("写入 vaults.json 失败：{error}");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(env: Option<&str>, config: Option<&str>, legacy: Option<&str>) -> StartupInputs {
        StartupInputs {
            env_root: env.map(PathBuf::from),
            config_root: config.map(PathBuf::from),
            legacy_root: legacy.map(PathBuf::from),
        }
    }

    #[test]
    fn env_wins_and_does_not_persist() {
        let decision = decide(&inputs(
            Some("/env"),
            Some("/configured"),
            Some("/legacy"),
        ));
        assert_eq!(
            decision,
            StartupDecision::Open {
                root: PathBuf::from("/env"),
                mode: OpenMode::Create,
                persist: false,
            }
        );
    }

    #[test]
    fn configured_root_wins_over_legacy() {
        let decision = decide(&inputs(None, Some("/configured"), Some("/legacy")));
        assert_eq!(
            decision,
            StartupDecision::Open {
                root: PathBuf::from("/configured"),
                mode: OpenMode::Existing,
                persist: true,
            }
        );
    }

    #[test]
    fn legacy_only_offers_choice_instead_of_opening() {
        let decision = decide(&inputs(None, None, Some("/legacy")));
        assert_eq!(
            decision,
            StartupDecision::Choose {
                legacy_root: Some(PathBuf::from("/legacy")),
            }
        );
    }

    #[test]
    fn no_inputs_offers_choice_without_default_root() {
        let decision = decide(&inputs(None, None, None));
        assert_eq!(
            decision,
            StartupDecision::Choose { legacy_root: None }
        );
    }
}
