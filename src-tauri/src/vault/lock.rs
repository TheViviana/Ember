use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{VaultError, VaultResult};
use crate::vault::{atomic, clock, paths, ulid};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 失效锁清理后的重试上限：每次重试都是一次独占创建；
/// 连续失败说明并发窗口内出现了活跃锁，按只读返回即可。
const ACQUIRE_ATTEMPTS: usize = 3;

/// 锁载荷（vault-format §7 简化版）：独占创建 + pid 存活判定，
/// 不再有心跳/租约——单机个人库用进程存活就够了。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockPayload {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub pid: u32,
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub app: String,
}

/// 只读原因收敛为两种：被占用（pid 存活）/ 丢失（契约保留态）。
/// 序列化为 camelCase 字符串，供 IPC 与前端文案映射共用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadonlyReason {
    /// 另一实例正在使用（pid 存活）
    LockedByOther,
    /// 运行期丢失（保留契约位；独占创建模型下运行期不会再出现）
    LockLost,
}

/// `acquire_detailed` 的失败：只读要带原因，其它错误原样上抛。
#[derive(Debug)]
pub enum AcquireFailure {
    Readonly(ReadonlyReason),
    Error(VaultError),
}

impl From<VaultError> for AcquireFailure {
    fn from(error: VaultError) -> Self {
        Self::Error(error)
    }
}

impl AcquireFailure {
    /// 退化回旧接口的错误形态：只读统一是 `VaultError::Readonly`。
    #[cfg(test)]
    fn into_error(self) -> VaultError {
        match self {
            Self::Readonly(_) => VaultError::Readonly,
            Self::Error(error) => error,
        }
    }
}

/// 持有的库锁。Drop 时只删除自己写入的锁文件。
pub struct VaultLock {
    path: PathBuf,
    pid: u32,
    machine_id: String,
    vault_id: String,
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        // 只删自己的锁文件：pid 与 machine 都要匹配，避免误删后来者
        if let Ok(bytes) = fs::read(&self.path) {
            if let Ok(payload) = serde_json::from_slice::<LockPayload>(&bytes) {
                if payload.pid == self.pid
                    && payload.machine_id == self.machine_id
                    && payload.vault_id == self.vault_id
                {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

/// 失效锁认领副本的进程内序号：同一进程的并发认领不能共用路径。
static CLAIM_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 获取库锁并保留只读原因，供 `vault_identity` 与前端文案区分「谁占了锁」。
///
/// 语义：独占创建（`create_new`）→ 已存在则读载荷判 pid →
/// pid 存活 = 被占用；pid 已死或载荷损坏 = 崩溃遗留，走原子认领：
/// `rename` 把锁文件**整体拿走**到唯一副本（不是先删除——两步之间别人可以
/// 插入一把新锁，无条件删除会误删它，造成双持有者），验证副本字节仍是判定时
/// 那份死锁后才在空出的原位 `create_new`；验证失败说明锁已被替换，
/// 用硬链接原位放回（目标存在则原子失败，不覆盖新锁）并按被占用返回。
pub fn acquire_detailed(
    root: &Path,
    vault_id: &str,
) -> Result<VaultLock, AcquireFailure> {
    let path = paths::lock_file(root);
    fs::create_dir_all(paths::workbench(root)).map_err(VaultError::from)?;
    let machine_id = machine_id()?;

    for _ in 0..ACQUIRE_ATTEMPTS {
        match create(&path, vault_id, &machine_id) {
            Ok(lock) => return Ok(lock),
            Err(VaultError::Readonly) => match read_lock(&path) {
                LockState::Alive => {
                    return Err(AcquireFailure::Readonly(ReadonlyReason::LockedByOther));
                }
                LockState::Missing => {
                    // 判定与认领之间锁被移走：下一轮直接尝试创建
                    continue;
                }
                LockState::Stale(claimed_bytes) => {
                    match claim_stale(&path, root, &claimed_bytes, vault_id, &machine_id)? {
                        Claim::Acquired(lock) => return Ok(lock),
                        Claim::Replaced => {
                            return Err(AcquireFailure::Readonly(ReadonlyReason::LockedByOther));
                        }
                        Claim::Contended => continue,
                    }
                }
            },
            Err(error) => return Err(AcquireFailure::Error(error)),
        }
    }
    // 连续三次都撞上活跃锁：按被占用返回
    Err(AcquireFailure::Readonly(ReadonlyReason::LockedByOther))
}

enum Claim {
    /// 认领成功并已创建新锁
    Acquired(VaultLock),
    /// 锁在判定后被替换成活锁（已放回原位）
    Replaced,
    /// 认领窗口内被别人抢先（原位空或竞态），可重试
    Contended,
}

/// 原子认领失效锁：rename 到唯一副本 → 字节验证 → 空出原位创建新锁。
fn claim_stale(
    path: &Path,
    root: &Path,
    claimed_bytes: &[u8],
    vault_id: &str,
    machine_id: &str,
) -> Result<Claim, AcquireFailure> {
    let claim = paths::workbench(root).join(format!(
        "lock.claim.{}.{}",
        std::process::id(),
        CLAIM_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    match fs::rename(path, &claim) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Claim::Contended),
        Err(error) => return Err(AcquireFailure::Error(error.into())),
    }
    // 拿到的必须仍是判定时那份死锁；变了说明期间有人写入了新锁——硬链接原位放回
    // （目标存在则原子失败，不覆盖新锁），副本丢弃。
    let same = fs::read(&claim).map(|bytes| bytes == claimed_bytes).unwrap_or(false);
    if !same {
        let _ = fs::hard_link(&claim, path);
        let _ = fs::remove_file(&claim);
        return Ok(Claim::Replaced);
    }
    // 原位已空：尝试独占创建
    let created = create(path, vault_id, machine_id);
    let _ = fs::remove_file(&claim);
    match created {
        Ok(lock) => Ok(Claim::Acquired(lock)),
        // 极端并发：验证与创建之间又被别人占了 → 下一轮重读重判
        Err(VaultError::Readonly) => Ok(Claim::Contended),
        Err(error) => Err(AcquireFailure::Error(error)),
    }
}

/// 获取库锁；抢不到返回 `VaultError::Readonly`，调用方据此进入只读观察者模式。
#[cfg(test)]
pub fn acquire(root: &Path, vault_id: &str) -> VaultResult<VaultLock> {
    acquire_detailed(root, vault_id).map_err(AcquireFailure::into_error)
}

fn create(path: &Path, vault_id: &str, machine_id: &str) -> VaultResult<VaultLock> {
    let mut handle = match OpenOptions::new().create_new(true).write(true).open(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(VaultError::Readonly);
        }
        Err(error) => return Err(error.into()),
    };

    let pid = std::process::id();
    let payload = LockPayload {
        vault_id: vault_id.to_string(),
        pid,
        machine_id: machine_id.to_string(),
        started_at: clock::now_iso8601(),
        app: APP_VERSION.to_string(),
    };
    let bytes = serde_json::to_vec(&payload)?;
    handle.write_all(&bytes)?;
    handle.sync_all()?;
    drop(handle);

    Ok(VaultLock {
        path: path.to_path_buf(),
        pid,
        machine_id: machine_id.to_string(),
        vault_id: vault_id.to_string(),
    })
}

enum LockState {
    /// 载荷可解析且 pid 存活：锁被占用
    Alive,
    /// 载荷损坏或 pid 已死：崩溃遗留，可认领（携带判定时的字节，认领后验证用）
    Stale(Vec<u8>),
    /// 文件已不存在：直接重试创建
    Missing,
}

fn read_lock(path: &Path) -> LockState {
    let bytes = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LockState::Missing,
        Err(_) => return LockState::Alive,
    };
    match serde_json::from_slice::<LockPayload>(&bytes) {
        // 载荷可解析：按 pid 存活判定；探测命令不可用时保守视为存活
        Ok(payload) if pid_alive(payload.pid) => LockState::Alive,
        Ok(_) => LockState::Stale(bytes),
        // 半截或损坏的锁文件无法证明持有者存活，按失效处理以恢复可用性
        Err(_) => LockState::Stale(bytes),
    }
}

/// pid 探测的三态：`Some(true/false)` 是确定结果，`None` 表示无法判断（命令不可用）。
fn pid_state(pid: u32) -> Option<bool> {
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        // 吞掉 stderr：死 pid 的探测会把 "No such process" 打进应用日志
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .map(|status| status.success())
}

fn pid_alive(pid: u32) -> bool {
    // 无 libc 依赖：用 kill -0 探测。命令不可用时保守视为存活，避免误抢锁。
    pid_state(pid).unwrap_or(true)
}

pub(crate) fn machine_id() -> VaultResult<String> {
    let dir = paths::app_support_dir();
    let file = dir.join("machine-id");
    if let Ok(text) = fs::read_to_string(&file) {
        let trimmed = text.trim();
        if ulid::is_ulid(trimmed) {
            return Ok(trimmed.to_string());
        }
    }
    fs::create_dir_all(&dir)?;
    let id = ulid::generate();
    atomic::write_atomic(&file, id.as_bytes())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let root = std::env::temp_dir().join(format!(
                "ember-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    const TEST_VAULT: &str = "01JTESTVAULT000000000000";

    fn payload_with(pid: u32) -> LockPayload {
        LockPayload {
            vault_id: TEST_VAULT.to_string(),
            pid,
            machine_id: machine_id().unwrap(),
            started_at: clock::now_iso8601(),
            app: "0.0.0".to_string(),
        }
    }

    fn write_lock(path: &Path, payload: &LockPayload) {
        fs::write(path, serde_json::to_vec(payload).unwrap()).unwrap();
    }

    #[test]
    fn drop_removes_only_own_lock() {
        let temp = TempRoot::new("lock-drop-own");
        let path = paths::lock_file(&temp.0);

        let lock = acquire(&temp.0, TEST_VAULT).unwrap();
        assert!(path.exists());
        drop(lock);
        assert!(!path.exists(), "Drop 应删除自己的锁文件");
    }

    #[test]
    fn drop_keeps_foreign_lock() {
        let temp = TempRoot::new("lock-drop-foreign");
        let path = paths::lock_file(&temp.0);

        let lock = acquire(&temp.0, TEST_VAULT).unwrap();
        // Drop 之前锁文件已被换成别人的载荷：Drop 不得误删
        write_lock(&path, &payload_with(999_999_999));
        drop(lock);
        assert!(path.exists(), "别人的锁文件不得被 Drop 删除");
    }

    #[test]
    fn active_lock_is_never_taken_over() {
        let temp = TempRoot::new("lock-active");
        let held = acquire(&temp.0, TEST_VAULT).unwrap();

        let second = acquire(&temp.0, TEST_VAULT);
        assert!(
            matches!(second, Err(VaultError::Readonly)),
            "活跃锁必须拒绝：pid 存活即被占用"
        );

        drop(held);
    }

    #[test]
    fn dead_pid_lock_is_claimed() {
        let temp = TempRoot::new("lock-dead-pid");
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let path = paths::lock_file(&temp.0);
        write_lock(&path, &payload_with(999_999_999));

        let lock = acquire(&temp.0, TEST_VAULT).expect("死 pid 的遗留锁应被清理并接管");
        let payload: LockPayload = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(payload.pid, std::process::id());
        drop(lock);
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_lock_is_claimed() {
        let temp = TempRoot::new("lock-corrupt");
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let path = paths::lock_file(&temp.0);
        fs::write(&path, b"garbage-not-json").unwrap();

        let lock = acquire(&temp.0, TEST_VAULT).expect("损坏的锁文件应被清理并接管");
        drop(lock);
        assert!(!path.exists());
    }

    #[test]
    fn concurrent_acquire_has_exactly_one_winner() {
        let temp = TempRoot::new("lock-race");
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let path = paths::lock_file(&temp.0);
        write_lock(&path, &payload_with(999_999_999));

        let root = temp.0.clone();
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| acquire(&root, TEST_VAULT));
            let second = scope.spawn(|| acquire(&root, TEST_VAULT));
            [first.join().unwrap(), second.join().unwrap()]
        });

        assert_eq!(
            results.iter().filter(|result| result.is_ok()).count(),
            1,
            "并发接管只能有一个实例拿到锁"
        );
        assert!(
            results
                .iter()
                .any(|result| matches!(result, Err(VaultError::Readonly))),
            "没抢到的实例必须得到只读，而不是第二把锁"
        );
    }

    #[test]
    fn released_lock_is_reacquirable() {
        let temp = TempRoot::new("lock-reacquire");
        let first = acquire(&temp.0, TEST_VAULT).unwrap();
        drop(first);
        let second = acquire(&temp.0, TEST_VAULT).unwrap();
        drop(second);
    }
}
