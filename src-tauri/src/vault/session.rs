use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{VaultError, VaultResult};
use crate::vault::config::{self, RecentVault};
use crate::vault::lock::ReadonlyReason;
use crate::vault::paths;
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
/// 两者都只接受既有库：环境变量写错时报错，不再顺手创建空库。
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
            mode: OpenMode::Existing,
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
    /// 打开成功但需要告知用户的问题（配置写失败、监视未启动、旧配置已备份）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// 当前会话：库实例与 watcher 必须一起换，避免监听旧根。
pub struct Session {
    vault: Option<Vault>,
    watcher: Option<Watcher>,
    /// 仅记录启动阶段的打开失败；用户主动切换失败不写这里（当前库继续可用）
    failure: Option<OpenFailure>,
    /// 打开成功但需要提示的降级信息；切换/重开时重置
    warning: Option<String>,
}

impl Session {
    pub fn vault(&self) -> VaultResult<&Vault> {
        self.vault.as_ref().ok_or(VaultError::Uninitialized)
    }

    fn push_warning(&mut self, text: String) {
        self.warning = Some(match self.warning.take() {
            Some(existing) => format!("{existing}；{text}"),
            None => text,
        });
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
        // 只有真正是库（有 .workbench/settings.json）才提示「继续使用」；
        // 空目录只是恰好同名，点进去必然失败。
        let legacy_root = paths::settings_file(&legacy).is_file().then_some(legacy);
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
                warning: None,
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
        let root = session.vault()?.root().to_string_lossy().to_string();
        let warning = session.warning.clone();
        drop(session);
        let (settings, _) = config::load();
        Ok(VaultInfo {
            root,
            recents: settings.recents,
            warning,
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
    ///
    /// 同一实际目录（解析软链、忽略尾斜杠）直接复用当前会话，绝不重建：
    /// 新实例抢不到本进程已持有的库锁，会把可写会话永久降成只读观察者。
    fn apply_open(
        &self,
        root: &Path,
        mode: OpenMode,
        persist: bool,
    ) -> Result<(), OpenFailure> {
        if let Some(identity) = self.reuse_same_root(root) {
            if persist {
                self.persist_open(root, &identity.vault_id);
            }
            return Ok(());
        }

        let opened = match mode {
            OpenMode::Create => Vault::open_or_init(root.to_path_buf()),
            OpenMode::Existing => Vault::open_existing(root.to_path_buf()),
        };
        let vault = opened.map_err(|error| OpenFailure {
            root: Some(root.to_string_lossy().to_string()),
            code: error.code().to_string(),
            message: open_failure_message(&error),
        })?;
        let identity = identity_of(&vault);
        let (watcher, watcher_warning) = match watcher::spawn(self.app.clone(), root.to_path_buf()) {
            Ok(value) => (Some(value), None),
            Err(error) => {
                // 不阻断打开，但必须让用户知道外部改动不会再自动刷新
                eprintln!("vault watcher 启动失败：{error}");
                (
                    None,
                    Some("库监视未能启动：外部改动不会自动刷新，请重启应用。".to_string()),
                )
            }
        };

        {
            let mut session = self.inner.lock().map_err(|_| OpenFailure {
                root: Some(root.to_string_lossy().to_string()),
                code: "startup_failed".to_string(),
                message: "库会话状态损坏".to_string(),
            })?;
            let previous_vault = session.vault.replace(vault);
            let previous_watcher = std::mem::replace(&mut session.watcher, watcher);
            session.failure = None;
            session.warning = watcher_warning;
            drop(session);
            // Drop 在锁外：watcher 线程 join 与旧锁释放都不该阻塞其它 IPC。
            drop(previous_watcher);
            drop(previous_vault);
        }

        if persist {
            self.persist_open(root, &identity.vault_id);
        }
        Ok(())
    }

    /// 目标路径与当前库是同一实际目录时返回当前身份，不做任何重建。
    fn reuse_same_root(&self, root: &Path) -> Option<VaultIdentity> {
        let session = self.inner.lock().ok()?;
        reuse_identity(&session, root)
    }

    /// 记录一次成功打开。失败不阻断使用，但必须落成界面可见的告警：
    /// 否则用户下次启动会莫名其妙回到旧库。
    fn persist_open(&self, root: &Path, vault_id: &str) {
        match config::record_open(root, vault_id) {
            Ok(None) => {}
            Ok(Some(notice)) => self.note_warning(notice),
            Err(error) => {
                eprintln!("写入 vaults.json 失败：{error}");
                self.note_warning(format!(
                    "库已打开，但无法保存库配置（vaults.json）：{error}。下次启动可能回到上一个库。"
                ));
            }
        }
    }

    fn note_warning(&self, text: String) {
        if let Ok(mut session) = self.inner.lock() {
            session.push_warning(text);
        }
    }
}

/// 同一实际目录判定：解析软链与尾斜杠后比较。任一路径不存在时视为不同，
/// 交给正常打开流程给出可读错误。
fn same_root(current: &Path, target: &Path) -> bool {
    match (current.canonicalize(), target.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// 打开失败的用户可读原因。`Startup` 的文案本身已是完整句子，
/// 去掉 `Display` 的「启动失败：」前缀，避免经 `open_user` 再包一层后出现双重前缀。
fn open_failure_message(error: &VaultError) -> String {
    match error {
        VaultError::Startup(message) => message.clone(),
        other => other.to_string(),
    }
}

/// 已打开库与目标根相同时复用当前身份（含只读原因），不重建实例。
fn reuse_identity(session: &Session, root: &Path) -> Option<VaultIdentity> {
    let vault = session.vault.as_ref()?;
    same_root(vault.root(), root).then(|| identity_of(vault))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!(
            "ember-session-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

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
                // 环境变量只指向既有库：写错时启动报错，不静默建空库
                mode: OpenMode::Existing,
                persist: false,
            }
        );
    }

    #[test]
    fn env_root_is_not_created_when_missing() {
        let root = temp_root("env-missing").join("typo");
        let Err(error) = Vault::open_existing(root.clone()) else {
            panic!("拼错的 EMBER_VAULT 不应打开成功");
        };
        assert!(matches!(error, VaultError::Startup(_)), "应为启动错误：{error}");
        assert!(!root.exists(), "环境变量指向的目录不得被自动创建");
    }

    #[test]
    fn same_actual_root_reuses_session_and_stays_writable() {
        let root = temp_root("same-root");
        let vault = Vault::open(root.clone()).unwrap();
        assert!(vault.writable());
        let session = Session {
            vault: Some(vault),
            watcher: None,
            failure: None,
            warning: None,
        };

        // 尾斜杠 / `.` 变体都是同一实际目录：必须复用，不得重建
        let dotted = root.join(".");
        let identity = reuse_identity(&session, &dotted).expect("同一实际根应复用当前会话");
        assert!(!identity.readonly, "复用不得把可写会话降成只读");
        assert_eq!(identity.vault_id, session.vault.as_ref().unwrap().id());

        assert!(same_root(&root, &dotted));
        assert!(same_root(
            &root,
            Path::new(&format!("{}/", root.to_string_lossy()))
        ));
        assert!(!same_root(&root, &root.join("nested")));
        assert!(
            reuse_identity(&session, &root.join("nested")).is_none(),
            "不同目录必须走正常打开流程"
        );

        drop(session);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rebuilding_while_lock_held_degrades_to_readonly() {
        let root = temp_root("same-root-rebuild");
        let first = Vault::open(root.clone()).unwrap();
        assert!(first.writable());

        // S1 的原始问题：持锁状态下重建实例，新实例抢不到自己的锁 → 永久只读
        let rebuilt = Vault::open(root.clone()).unwrap();
        assert!(
            !rebuilt.writable(),
            "重建实例会降级为只读观察者（因此同根重开必须复用）"
        );

        drop(rebuilt);
        drop(first);
        let _ = fs::remove_dir_all(&root);
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
