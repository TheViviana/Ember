pub mod atomic;
pub mod backup;
pub mod clock;
pub mod lock;
pub mod media;
pub mod paths;
pub mod trash;
pub mod ulid;
pub mod watcher;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use crate::error::{VaultError, VaultResult};

/// 当前 `.workbench/` schema 版本（规范 §8）。
const SETTINGS_SCHEMA_VERSION: u64 = 1;

/// 画布目录（规范 §8.2）：`vault_list` 保持只含 `.md`，画布清单走 `list_canvases`。
const CANVAS_DIR: &str = ".workbench/canvas";

/// 孤儿临时文件保留期：正常一次原子写远不到 1 小时，超龄的 `.ember-tmp-`
/// 必然是崩溃遗留的孤儿（索引与画布都是派生数据，残留清扫即可恢复）。
const ORPHAN_TEMP_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// 旧版软删除副本（`.workbench/trash/<ULID>/`）保留期。
/// v1 起删除直接进系统回收站，库内不再产生新副本；这里只为历史库做惰性回收。
const TRASH_RETENTION: Duration = Duration::from_secs(30 * 24 * 3600);

/// IPC 可接受的写入意图（kernel types.ts 的 WriteIntent）：仅校验来源合法性，不落盘。
const WRITE_INTENTS: [&str; 3] = ["user", "migration", "system"];

/// 库运行态：根路径、身份、锁与写入串行化。
pub struct Vault {
    root: PathBuf,
    id: String,
    /// 启动时是否抢到锁（只读观察者）。独占创建 + pid 存活模型下，
    /// 锁一旦持有即贯穿整个会话（pid 存活期间无人能接管），运行期不会降级。
    initially_readonly: bool,
    /// 启动时进入只读的原因（被占用）。
    startup_readonly_reason: Option<lock::ReadonlyReason>,
    /// 拿到锁才持有；抢占不到时为 None，整个会话只读。
    /// 独占创建模型下写一次不再变更，不需要 Mutex。
    _lock: Option<lock::VaultLock>,
    /// 串行化写入：rename 的检查与落盘必须按顺序发生。
    write_gate: Mutex<()>,
}

impl Vault {
    /// 打开库：确保身份文件 → 抢锁（独占创建 + pid 存活判定）→ 启动清扫。
    /// 抢不到锁进入只读观察者模式（被另一实例占用）。
    pub fn open(root: PathBuf) -> VaultResult<Self> {
        fs::create_dir_all(&root)?;
        let id = ensure_identity(&root)?;

        let mut startup_readonly_reason: Option<lock::ReadonlyReason> = None;
        let guard: Option<lock::VaultLock> = match lock::acquire_detailed(&root, &id) {
            Ok(value) => Some(value),
            Err(lock::AcquireFailure::Readonly(reason)) => {
                eprintln!(
                    "库只读（{}），进入观察者模式：{}",
                    match reason {
                        lock::ReadonlyReason::LockedByOther => "已被其它实例打开",
                        lock::ReadonlyReason::LockLost => "库锁丢失",
                    },
                    root.display()
                );
                startup_readonly_reason = Some(reason);
                None
            }
            Err(lock::AcquireFailure::Error(error)) => return Err(error),
        };
        let initially_readonly = guard.is_none();

        // 只有持锁实例才执行启动清扫；另一实例可能正在写。
        if !initially_readonly {
            sweep_housekeeping(&root);
        }

        // 抢锁后重读：两个实例首次启动可能都写过身份，以磁盘上的胜者为准。
        let id = ensure_identity(&root)?;

        Ok(Vault {
            root,
            id,
            initially_readonly,
            startup_readonly_reason,
            _lock: guard,
            write_gate: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// 当前只读原因；可写时返回 None。
    /// 独占创建模型下只读只发生在启动时（被另一实例占用）；
    /// 兜底分支构造 `LockLost`，保证契约的两态文案始终可用。
    pub fn readonly_reason(&self) -> Option<lock::ReadonlyReason> {
        if let Some(reason) = self.startup_readonly_reason {
            return Some(reason);
        }
        if self.initially_readonly {
            return Some(lock::ReadonlyReason::LockLost);
        }
        None
    }

    pub fn read(&self, relative: &str) -> VaultResult<Option<Vec<u8>>> {
        let (absolute, _) = paths::resolve(&self.root, relative)?;
        match fs::read(&absolute) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn write(&self, relative: &str, bytes: &[u8], intent: &str) -> VaultResult<()> {
        // intent 表达写入来源；非法值在入口拒绝。
        if !WRITE_INTENTS.contains(&intent) {
            return Err(VaultError::Encoding(format!("非法的写入意图：{intent}")));
        }
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        // 原子写：临时文件 fsync → rename → 目录 fsync，与其它一切落盘共用同一保证。
        // 正文唯一真相在文件本身；索引/画布都是派生数据，崩溃残留由启动清扫兜底。
        atomic::write_atomic(&absolute, bytes).map_err(|error| with_path(error, &absolute))
    }

    /// 删除：优先系统回收站，不可用时降级 Finder 与库内回收目录（vault-format §8.3）。
    /// 文件不存在视为成功，便于内核做幂等对账。
    pub fn remove(&self, relative: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        match fs::symlink_metadata(&absolute) {
            Ok(_) => {
                trash::trash(&self.root, &absolute)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    /// 永久删除：**仅供内核回滚内部使用**（文章创建后画布写入失败），
    /// 不是用户删除入口——用户删除一律走 [`Vault::remove`] 进系统回收站。
    /// 不注册为用户可调用的 `core.doc.purge` 命令（契约里该项仍为 v1 未实现）。
    pub fn purge(&self, relative: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (absolute, normalized) = paths::resolve(&self.root, relative)?;
        paths::ensure_not_reserved(&normalized)?;
        let _gate = self.begin_write()?;
        match fs::remove_file(&absolute) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(with_path(error.into(), &absolute)),
        }
    }

    pub fn rename(&self, from: &str, to: &str) -> VaultResult<()> {
        self.ensure_writable()?;
        let (source, from_normalized) = paths::resolve(&self.root, from)?;
        let (target, to_normalized) = paths::resolve(&self.root, to)?;
        paths::ensure_not_reserved(&from_normalized)?;
        paths::ensure_not_reserved(&to_normalized)?;
        let _gate = self.begin_write()?;
        if !source.is_file() {
            return Err(VaultError::NotFound(from.to_string()));
        }
        if source == target {
            return Ok(());
        }
        // 目标已存在时拒绝覆盖。注意：这是降低概率而非杜绝——检查与 fs::rename 之间
        // 仍有窗口，外部进程此时创建同名文件仍会被覆盖（POSIX rename 是覆盖语义）。
        if fs::symlink_metadata(&target).is_ok() {
            return Err(VaultError::PathExists(to.to_string()));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&source, &target)?;
        Ok(())
    }

    /// 全库 Markdown 文件清单（相对 POSIX 路径，字典序），跳过 `.workbench/` 与隐藏项。
    pub fn list(&self) -> VaultResult<Vec<String>> {
        let mut files = Vec::new();
        collect_documents(&self.root, &self.root, &mut files)?;
        files.sort();
        Ok(files)
    }

    /// 画布清单（`.workbench/canvas/<id>.json` 的相对路径，字典序）。
    /// 与 `list` 分开：文档对账只关心 `.md`，画布库需要 `.json`；
    /// `vault_list` 保持只返回 Markdown 的契约，避免文档目录混入画布文件。
    pub fn list_canvases(&self) -> VaultResult<Vec<String>> {
        let dir = paths::workbench(&self.root).join("canvas");
        let entries = match fs::read_dir(&dir) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !entry.file_type()?.is_file() || !name.ends_with(".json") {
                continue;
            }
            files.push(format!("{CANVAS_DIR}/{name}"));
        }
        files.sort();
        Ok(files)
    }

    /// 库健康检查清单：只读遍历，返回文档、`.workbench` 画布/历史 JSON 与符号链接。
    /// 不跟随符号链接；`media/` 与 `settings.json` 等无关文件不返回，避免清单膨胀。
    pub fn scan(&self) -> VaultResult<Vec<ScanEntry>> {
        let mut entries = Vec::new();
        collect_scan(&self.root, &self.root, &mut entries)?;
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(entries)
    }

    pub fn stat(&self, relative: &str) -> VaultResult<Option<(String, u64)>> {
        let (absolute, _) = paths::resolve(&self.root, relative)?;
        let metadata = match fs::metadata(&absolute) {
            Ok(value) => value,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let millis = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default();
        Ok(Some((clock::iso8601(millis), metadata.len())))
    }

    /// 当前是否允许写入：启动即持锁则整个会话可写（独占创建模型下运行期不会失守）。
    pub fn writable(&self) -> bool {
        self.ensure_writable().is_ok()
    }

    pub(crate) fn ensure_writable(&self) -> VaultResult<()> {
        // 启动时没抢到锁（被其它实例占用）→ 拒绝写入。
        if self.initially_readonly {
            return Err(VaultError::Readonly);
        }
        Ok(())
    }

    /// 进入写入临界区：write_gate 串行化所有落盘路径（正文、删除、改名、图片），
    /// 保证同一实例内的检查与写盘不被其它写操作插入。
    pub(crate) fn begin_write(&self) -> VaultResult<MutexGuard<'_, ()>> {
        let gate = self
            .write_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(gate)
    }
}

/// 给 IO 错误补上绝对磁盘路径，便于用户直接定位文件。
fn with_path(error: VaultError, path: &Path) -> VaultError {
    match error {
        VaultError::Io(inner) => VaultError::IoAt {
            path: path.display().to_string(),
            message: inner.to_string(),
        },
        other => other,
    }
}

/// 启动期惰性清扫（持锁后执行；只读观察者不执行）。
///
/// - 全库孤儿 `.ember-tmp-` 临时文件（>24h）：崩溃遗留，永远无人清理；
/// - `.workbench/trash/<ULID>/`（>30 天）：**旧版**软删除副本的惰性回收。
///   删除直接进系统回收站，库内不再产生新副本；历史库的副本冻结保留到期后清理。
///
/// 全部失败只记日志不影响启动；mtime 不可读按保守不删处理。
/// `.workbench/` 内的临时文件同样参与清扫：24h 年龄门槛远大于一次原子写的
/// 存活时间，不会误删在途 temp。
fn sweep_housekeeping(root: &Path) {
    let now = SystemTime::now();
    let temps = sweep_orphan_temps(root, now);
    let claims = sweep_claim_copies(root, now);
    let trash = sweep_expired_trash(root, now);
    if temps > 0 || claims > 0 || trash > 0 {
        eprintln!("启动清扫：清理 {temps} 个孤儿临时文件、{claims} 个失效锁认领副本、{trash} 个过期回收目录");
    }
}

/// `.workbench/` 顶层：认领者在 rename 拿走死锁之后、删除副本之前崩溃留下的
/// `lock.claim.<pid>.<seq>` 文件。复用孤儿 temp 的 24h 门槛——认领到删除只隔
/// 几条指令，超龄副本必然是崩溃残留；只匹配数字后缀形态，`.lock` 一律不碰。
fn sweep_claim_copies(root: &Path, now: SystemTime) -> usize {
    let mut removed = 0usize;
    let entries = match fs::read_dir(paths::workbench(root)) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("lock.claim.") else {
            continue;
        };
        let numeric =
            rest.split('.').all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()));
        if !numeric || rest.is_empty() {
            continue;
        }
        let path = entry.path();
        if !older_than(&path, now, ORPHAN_TEMP_MAX_AGE) {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn sweep_orphan_temps(dir: &Path, now: SystemTime) -> usize {
    let mut removed = 0usize;
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            // 符号链接两臂都不命中（与 resolve 的拒链接策略一致）
            Ok(file_type) if file_type.is_dir() => {
                removed += sweep_orphan_temps(&path, now);
            }
            Ok(file_type) if file_type.is_file() => {
                let name = entry.file_name();
                if !name.to_string_lossy().contains(".ember-tmp-") {
                    continue;
                }
                if !older_than(&path, now, ORPHAN_TEMP_MAX_AGE) {
                    continue;
                }
                if fs::remove_file(&path).is_ok() {
                    removed += 1;
                }
            }
            _ => {}
        }
    }
    removed
}

fn sweep_expired_trash(root: &Path, now: SystemTime) -> usize {
    let trash = root.join(paths::WORKBENCH_DIR).join("trash");
    let mut removed = 0usize;
    let entries = match fs::read_dir(&trash) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if !older_than(&entry.path(), now, TRASH_RETENTION) {
            continue;
        }
        if fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn older_than(path: &Path, now: SystemTime, max_age: Duration) -> bool {
    match fs::metadata(path).and_then(|metadata| metadata.modified()) {
        Ok(modified) => now
            .duration_since(modified)
            .map(|age| age > max_age)
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// 读取 `<vault>/.workbench/settings.json` 的库身份；缺失时生成 ULID 并落盘。
/// 只读不改写，未知键原样保留（v1 不重写该文件）。
fn ensure_identity(root: &Path) -> VaultResult<String> {
    let file = paths::settings_file(root);
    match fs::read_to_string(&file) {
        Ok(text) => identity_from(&text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_identity(root, &file),
        // 存在但读不出来时不能重建身份，否则会静默换掉库 ID。
        Err(error) => Err(error.into()),
    }
}

fn create_identity(root: &Path, file: &Path) -> VaultResult<String> {
    let id = ulid::generate();
    let name = root
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "Ember Vault".to_string());
    let settings = serde_json::json!({
        "schemaVersion": SETTINGS_SCHEMA_VERSION,
        "vault": {
            "id": id,
            "name": name,
            "createdAt": clock::now_iso8601(),
        },
        "ui": {},
        "linkOverrides": {},
    });
    fs::create_dir_all(paths::workbench(root))?;
    atomic::write_atomic(file, &serde_json::to_vec_pretty(&settings)?)?;
    Ok(id)
}

fn identity_from(text: &str) -> VaultResult<String> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let version = value
        .get("schemaVersion")
        .and_then(|item| item.as_u64())
        .ok_or_else(|| VaultError::Encoding("settings.json 缺少 schemaVersion".to_string()))?;
    if version != SETTINGS_SCHEMA_VERSION {
        return Err(VaultError::Encoding(format!(
            "settings.json schemaVersion={version}，当前应用只支持 {SETTINGS_SCHEMA_VERSION}"
        )));
    }
    let id = value
        .pointer("/vault/id")
        .and_then(|item| item.as_str())
        .ok_or(VaultError::Uninitialized)?;
    if !ulid::is_ulid(id) {
        return Err(VaultError::Uninitialized);
    }
    Ok(id.to_string())
}

fn collect_documents(root: &Path, dir: &Path, out: &mut Vec<String>) -> VaultResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::WORKBENCH_DIR || name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_documents(root, &entry.path(), out)?;
            continue;
        }
        if !file_type.is_file() || !name.ends_with(".md") {
            continue;
        }
        let relative = entry.path();
        if let Ok(stripped) = relative.strip_prefix(root) {
            out.push(stripped.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

/// 库健康检查清单条目：`kind` 为 `file` 或 `symlink`。
#[derive(serde::Serialize)]
pub struct ScanEntry {
    pub path: String,
    pub kind: String,
    /// 普通文件为字节数；符号链接为链接自身长度
    pub size: u64,
}

fn collect_scan(root: &Path, dir: &Path, out: &mut Vec<ScanEntry>) -> VaultResult<()> {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "node_modules" {
            continue;
        }
        // 除 .workbench 外，隐藏项不进入库索引范围（与 collect_documents 一致）
        if name.starts_with('.') && name != paths::WORKBENCH_DIR {
            continue;
        }
        let absolute = entry.path();
        let relative = match absolute.strip_prefix(root) {
            Ok(value) => value.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        // 历史回收与备份不属于体检范围
        if relative == ".workbench/trash" || relative == ".workbench/backup" {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            // 只记录链接自身，绝不跟随到库外目录
            let size = fs::symlink_metadata(&absolute)
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            out.push(ScanEntry {
                path: relative,
                kind: "symlink".to_string(),
                size,
            });
            continue;
        }
        if file_type.is_dir() {
            collect_scan(root, &absolute, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let in_workbench_json = (relative.starts_with(".workbench/canvas/")
            || relative.starts_with(".workbench/history/"))
            && name.ends_with(".json");
        let is_markdown = name.ends_with(".md") || name.ends_with(".markdown");
        if !is_markdown && !in_workbench_json {
            continue;
        }
        out.push(ScanEntry {
            path: relative,
            kind: "file".to_string(),
            size: entry.metadata()?.len(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    struct TempVault {
        vault: Vault,
        root: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("ember-vault-{}-{nanos}-{seq}", std::process::id()));
            let vault = Vault::open(root.clone()).unwrap();
            Self { vault, root }
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn reserved_code(error: VaultError) -> String {
        assert!(
            matches!(error, VaultError::PathOutside(ref message) if message.contains("保留路径")),
            "应为保留路径错误：{error}"
        );
        error.code().to_string()
    }

    #[test]
    fn write_rejects_reserved_paths_but_keeps_frontend_targets() {
        let temp = TempVault::new();

        for path in [
            ".workbench/.lock",
            ".workbench",
            ".doc.md.ember-tmp-1731234567-1",
            "media/ab/01J.png",
        ] {
            let error = temp.vault.write(path, b"x", "user").unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }

        // 前端合法写入目标不受影响。
        temp.vault.write("notes/a.md", b"# hi", "user").unwrap();
        temp.vault
            .write(".workbench/settings.json", b"{}", "user")
            .unwrap();
        temp.vault
            .write(".workbench/canvas/01J.json", b"{}", "user")
            .unwrap();
    }

    #[test]
    fn remove_rejects_reserved_paths() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        for path in [".workbench/.lock", "media/x.png"] {
            let error = temp.vault.remove(path).unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }
        // 保留路径之外的清理走 purge，避免把测试文件塞进用户回收站（真实落点由下方专测覆盖）
        temp.vault.purge("notes/a.md").unwrap();
    }

    #[test]
    fn remove_missing_file_is_idempotent() {
        let temp = TempVault::new();
        // 内核做幂等对账：不存在就是成功，不报错、不产生回收站动作
        temp.vault.remove("notes/never-existent.md").unwrap();
        temp.vault.purge("notes/never-existent.md").unwrap();
    }

    #[test]
    fn remove_on_readonly_vault_is_rejected() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        // 同库第二个实例抢不到锁 → 只读观察者；删除必须在触盘前被拒
        let observer = Vault::open(temp.root.clone()).unwrap();
        assert!(!observer.writable(), "第二个实例应为只读观察者");
        let error = observer.remove("notes/a.md").unwrap_err();
        assert!(matches!(error, VaultError::Readonly), "只读库删除应被拒：{error}");
        assert_eq!(error.code(), "vault_locked");
        assert!(temp.root.join("notes/a.md").exists(), "文件必须保持原样");
    }

    /// 系统回收站落点（本地卷：`~/.Trash/<name>`）。测试只接受绝对落点，避免误删。
    #[cfg(target_os = "macos")]
    fn system_trash_path(name: &str) -> PathBuf {
        let home = std::env::var("HOME").expect("测试机应有 HOME");
        PathBuf::from(home).join(".Trash").join(name)
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn remove_moves_document_into_system_trash() {
        let temp = TempVault::new();
        let name = format!("ember-trash-{}.md", ulid::generate());
        let relative = format!("notes/{name}");
        temp.vault.write(&relative, b"trash me", "user").unwrap();
        let source = temp.root.join("notes").join(&name);
        let landed = system_trash_path(&name);
        assert!(!landed.exists(), "回收站不应已有同名残留：{}", landed.display());

        temp.vault.remove(&relative).unwrap();

        assert!(!source.exists(), "源文件必须离开库内");
        assert!(
            temp.vault
                .list()
                .unwrap()
                .iter()
                .all(|path| path != &relative),
            "库清单不得再包含被删文档"
        );
        assert!(
            landed.exists(),
            "文件应出现在系统回收站：{}",
            landed.display()
        );
        // 清理：测完从回收站删除，不污染用户回收站
        fs::remove_file(&landed).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn purge_deletes_permanently_without_touching_trash() {
        let temp = TempVault::new();
        let name = format!("ember-purge-{}.md", ulid::generate());
        let relative = format!("notes/{name}");
        temp.vault.write(&relative, b"purge me", "user").unwrap();
        let landed = system_trash_path(&name);

        temp.vault.purge(&relative).unwrap();

        assert!(!temp.root.join("notes").join(&name).exists());
        assert!(!landed.exists(), "回滚用永久删除不得在回收站留痕");
    }

    #[test]
    fn rename_rejects_reserved_paths_on_both_ends() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"x", "user").unwrap();

        // 改名进保留路径
        let error = temp
            .vault
            .rename("notes/a.md", ".workbench/.lock")
            .unwrap_err();
        assert_eq!(reserved_code(error), "path_outside_vault");
        // 合法改名不受影响
        temp.vault.rename("notes/a.md", "notes/b.md").unwrap();
        assert!(temp.vault.read("notes/b.md").unwrap().is_some());
    }

    #[test]
    fn rename_refuses_existing_target_and_keeps_both_files() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"source", "user").unwrap();
        temp.vault.write("notes/b.md", b"target", "user").unwrap();

        let error = temp.vault.rename("notes/a.md", "notes/b.md").unwrap_err();
        assert_eq!(error.code(), "path_exists");
        assert_eq!(
            temp.vault.read("notes/a.md").unwrap().unwrap().as_slice(),
            b"source"
        );
        assert_eq!(
            temp.vault.read("notes/b.md").unwrap().unwrap().as_slice(),
            b"target"
        );

        // 目标空出来之后仍可正常改名
        temp.vault.rename("notes/a.md", "notes/c.md").unwrap();
        assert!(temp.vault.read("notes/c.md").unwrap().is_some());
        assert!(temp.vault.read("notes/a.md").unwrap().is_none());
    }

    #[test]
    fn write_rejects_unknown_intent_and_accepts_the_three_known_ones() {
        let temp = TempVault::new();

        let error = temp.vault.write("notes/a.md", b"x", "renderer").unwrap_err();
        assert_eq!(error.code(), "invalid_payload");
        assert!(temp.vault.read("notes/a.md").unwrap().is_none());

        for intent in ["user", "migration", "system"] {
            temp.vault.write("notes/a.md", b"x", intent).unwrap();
        }
    }

    #[test]
    fn write_rejects_traversal_still_works() {
        let temp = TempVault::new();
        let error = temp.vault.write("../outside.md", b"x", "user").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
    }

    #[test]
    fn write_rejects_case_variant_reserved_paths() {
        let temp = TempVault::new();
        // 字符串层大小写折叠拦截（不依赖文件系统是否大小写不敏感）。
        for path in [".WORKBENCH/.lock", "Media/ab/x.png"] {
            let error = temp.vault.write(path, b"x", "user").unwrap_err();
            assert_eq!(reserved_code(error), "path_outside_vault", "路径：{path}");
        }
    }

    #[test]
    fn stale_lock_from_dead_process_is_reclaimed_on_open() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"first", "user").unwrap();

        // 上个实例崩溃遗留的锁（pid 已死）：本次启动直接接管，可写。
        let stale = lock::LockPayload {
            vault_id: temp.vault.id().to_string(),
            pid: 999_999_999,
            machine_id: "01JFORGEDMACHINEID000000".to_string(),
            started_at: clock::now_iso8601(),
            app: "0.0.0".to_string(),
        };
        atomic::write_atomic(
            &paths::lock_file(&temp.root),
            &serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();

        let reopened = Vault::open(temp.root.clone()).unwrap();
        assert!(reopened.writable(), "死 pid 的遗留锁应被接管而不是只读");
        reopened.write("notes/a.md", b"second", "user").unwrap();
        assert_eq!(fs::read(temp.root.join("notes/a.md")).unwrap(), b"second");
    }

    #[test]
    fn unsupported_settings_version_fails_without_rewriting_file() {
        let temp = TempVault::new();
        let settings = paths::settings_file(&temp.root);
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
        value["schemaVersion"] = serde_json::json!(2);
        let bytes = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(&settings, &bytes).unwrap();

        // 启动失败要带回可读原因（前端据此显示启动失败页），且不得覆盖用户文件
        let Err(error) = Vault::open(temp.root.clone()) else {
            panic!("高版本 settings 不应打开成功");
        };
        assert!(
            matches!(error, VaultError::Encoding(ref message) if message.contains("schemaVersion=2")),
            "应为版本错误：{error}"
        );
        assert_eq!(fs::read(&settings).unwrap(), bytes, "不得改写用户文件");
    }

    /// 用 touch -t 把目标 mtime 拨到 2020-01-01，模拟「早已存在」。
    fn backdate(path: &Path) {
        let status = std::process::Command::new("/usr/bin/touch")
            .args(["-t", "202001010000"])
            .arg(path)
            .status()
            .expect("touch 可用");
        assert!(status.success(), "touch -t 执行失败");
    }

    #[test]
    fn housekeeping_sweeps_orphan_temps_and_expired_trash() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"body", "user").unwrap();

        // 孤儿临时文件：崩溃遗留（mtime 拨旧 → 应被清扫）
        let orphan = temp.root.join("notes").join(".a.md.ember-tmp-100-1");
        fs::write(&orphan, b"half").unwrap();
        backdate(&orphan);
        // 新鲜临时文件：在途写入，不得误删
        let fresh = temp.root.join("notes").join(".b.md.ember-tmp-200-2");
        fs::write(&fresh, b"writing").unwrap();
        // `.workbench/` 内崩溃遗留的锁 temp 也要回收，但在途 temp 不得误删
        let stale_internal = temp.root.join(".workbench").join(".lock.ember-tmp-100-3");
        fs::write(&stale_internal, b"stale").unwrap();
        backdate(&stale_internal);
        let fresh_internal = temp.root.join(".workbench").join(".lock.ember-tmp-200-4");
        fs::write(&fresh_internal, b"writing").unwrap();
        // 过期与保留期内的回收目录
        let expired_trash = temp.root.join(".workbench").join("trash").join("01JOLD");
        let fresh_trash = temp.root.join(".workbench").join("trash").join("01JNEW");
        fs::create_dir_all(expired_trash.join("a.md")).unwrap();
        fs::write(expired_trash.join("a.md").join("x.md"), b"deleted").unwrap();
        fs::create_dir_all(&fresh_trash).unwrap();
        backdate(&expired_trash);

        let now = SystemTime::now();
        let temps = sweep_orphan_temps(&temp.root, now);
        let trash = sweep_expired_trash(&temp.root, now);

        assert_eq!(temps, 2, "回收孤儿临时文件（含 .workbench 内部）");
        assert_eq!(trash, 1, "只清理过期回收目录");
        assert!(!orphan.exists(), "孤儿临时文件应被回收");
        assert!(fresh.exists(), "在途临时文件不得误删");
        assert!(!stale_internal.exists(), ".workbench 内超龄 temp 应被回收");
        assert!(fresh_internal.exists(), "在途 temp 不得误删");
        assert!(!expired_trash.exists(), "过期回收目录应被回收");
        assert!(fresh_trash.exists(), "保留期内的回收目录不得误删");
        assert!(temp.vault.read("notes/a.md").unwrap().is_some(), "正文不受清扫影响");
    }

    #[test]
    fn symlink_prefixes_are_rejected() {
        let temp = TempVault::new();
        let outside = tempfile_dir("ember-symlink-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"outside").unwrap();

        let link_dir = temp.root.join("notes");
        fs::create_dir_all(&link_dir).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, link_dir.join("escape")).unwrap();

        // 目录链接：读/写都不得穿透
        let error = temp.vault.read("notes/escape/secret.md").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
        let error = temp
            .vault
            .write("notes/escape/planted.md", b"x", "user")
            .unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));
        let error = temp.vault.stat("notes/escape/secret.md").unwrap_err();
        assert!(matches!(error, VaultError::PathOutside(_)));

        fs::remove_dir_all(&outside).unwrap();
    }

    fn tempfile_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "{label}-{}-{nanos}-{seq}",
            std::process::id()
        ))
    }

    #[test]
    fn scan_reports_markdown_and_symlinks_without_following() {
        let temp = TempVault::new();
        temp.vault.write("notes/a.md", b"# a", "user").unwrap();
        temp.vault
            .write("notes/b.markdown", b"# b", "user")
            .unwrap();
        temp.vault
            .write(".workbench/canvas/x.json", b"{}", "user")
            .unwrap();
        temp.vault
            .write(".workbench/history/x.1.json", b"{}", "user")
            .unwrap();
        fs::create_dir_all(temp.root.join("media")).unwrap();
        fs::write(temp.root.join("media/pic.png"), b"png").unwrap();
        fs::create_dir_all(temp.root.join(".git")).unwrap();
        fs::write(temp.root.join(".git/config"), b"git").unwrap();

        let outside = tempfile_dir("ember-scan-outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.md"), b"# secret").unwrap();
        std::os::unix::fs::symlink(&outside, temp.root.join("notes/escape")).unwrap();

        let entries = temp.vault.scan().unwrap();
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();

        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"notes/b.markdown"));
        assert!(paths.contains(&".workbench/canvas/x.json"));
        assert!(paths.contains(&".workbench/history/x.1.json"));
        assert!(paths.contains(&"notes/escape"));
        assert!(!paths.iter().any(|path| path.ends_with("secret.md")));
        assert!(!paths.contains(&"media/pic.png"));
        assert!(!paths.contains(&".git/config"));

        let link = entries
            .iter()
            .find(|entry| entry.path == "notes/escape")
            .expect("符号链接应出现在清单中");
        assert_eq!(link.kind, "symlink");

        fs::remove_dir_all(&outside).unwrap();
    }
}
