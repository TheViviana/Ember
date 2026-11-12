use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{VaultError, VaultResult};
use crate::vault::{atomic, clock, paths, ulid};

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// 心跳等待的切片步长：Drop join 最多阻塞这么久
const HEARTBEAT_STEP: Duration = Duration::from_millis(250);
const STALE_AFTER: Duration = Duration::from_secs(30);
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 失效锁认领副本的文件名前缀（`<prefix><pid>.<leaseToken>.<序号>`）。
pub const TAKEOVER_PREFIX: &str = "lock.takeover.";

/// 认领副本的进程内序号：同一进程的两个认领不能共用路径，
/// 否则后者的清理会删掉前者刚 rename 出来的副本，两个都拿不到租约。
static TAKEOVER_SEQ: AtomicU64 = AtomicU64::new(0);

/// 是否为认领副本名：前缀之后必须恰好是三段纯数字，避免误伤同目录的相似文件。
pub fn is_takeover_copy(name: &str) -> bool {
    let Some(rest) = name.strip_prefix(TAKEOVER_PREFIX) else {
        return false;
    };
    let mut parts = rest.split('.');
    let numeric = |value: Option<&str>| {
        value.is_some_and(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
    };
    numeric(parts.next()) && numeric(parts.next()) && numeric(parts.next()) && parts.next().is_none()
}

/// 规范 §7 的锁载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockPayload {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub pid: u32,
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "heartbeatAt")]
    pub heartbeat_at: String,
    /// 租约代次：每次接管 +1，只增不减。写入前用它证明锁仍归本实例。
    #[serde(rename = "leaseToken", default)]
    pub lease_token: u64,
    pub app: String,
}

/// 只读原因：启动时由锁判定给出，运行期固定为 `LockLost`。
/// 序列化为 camelCase 字符串，供 IPC 与前端文案映射共用。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadonlyReason {
    /// 另一实例正常持锁（心跳新鲜）
    LockedByOther,
    /// 另一实例持锁但心跳已停：本机进程仍存活，等它退出而不是抢锁
    LockedByStalled,
    /// 判为失效后认领失败（并发抢锁输了）
    ClaimFailed,
    /// 运行期心跳发现锁被接管或丢失
    LockLost,
    /// journal 恢复失败，损坏现场已保留，需人工处理
    JournalCorrupt,
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

/// 持有的库锁。Drop 时停止心跳并删除自己写入的锁文件。
pub struct VaultLock {
    path: PathBuf,
    pid: u32,
    lease_token: u64,
    stop: Arc<AtomicBool>,
    /// 心跳健康标志：锁被其它实例接管、锁文件丢失或心跳写失败时翻 false，
    /// 持有方据此把运行态降级为只读，避免「心跳已死仍在写」的双写者窗口。
    healthy: Arc<AtomicBool>,
    heartbeat: Option<JoinHandle<()>>,
    /// 本实例最后一次成功落盘的 heartbeat_at；与锁文件内容比对即租约校验。
    heartbeat_at: Arc<Mutex<String>>,
}

impl VaultLock {
    /// 共享健康标志：false = 心跳已判定锁失守（被接管/写失败），持有方必须停止一切写操作。
    /// 供 Vault 在 ensure_writable 里实时检查。
    pub fn health_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.healthy)
    }

    /// 写前栅栏：锁文件仍带本实例的租约代次与心跳时间才算持有成功。
    /// 任何不一致都说明锁已被接管或心跳停摆，调用方必须立即转只读。
    pub fn verify_lease(&self) -> bool {
        // 读期望值与读文件放在同一把锁的作用域内，两个方向都覆盖：
        // - 心跳先写文件、后更新内存 → 校验方不会读到「文件新、内存旧」；
        // - 校验方先取内存、后读文件 → 也不会读到「内存旧、文件新」。
        // 若像过去那样先克隆再释放锁去读，心跳恰好插入就会把正常心跳误判为失守。
        let expected = self
            .heartbeat_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bytes = match fs::read(&self.path) {
            Ok(value) => value,
            Err(_) => return false,
        };
        match serde_json::from_slice::<LockPayload>(&bytes) {
            Ok(current) => {
                current.pid == self.pid
                    && current.lease_token == self.lease_token
                    && current.heartbeat_at == *expected
            }
            Err(_) => false,
        }
    }
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.heartbeat.take() {
            let _ = handle.join();
        }
        if let Ok(bytes) = fs::read(&self.path) {
            if let Ok(payload) = serde_json::from_slice::<LockPayload>(&bytes) {
                // 只删自己的租约：同一 pid 也不能误删后来者的锁文件
                if payload.pid == self.pid && payload.lease_token == self.lease_token {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

/// 读取现存锁的租约代次；缺失或损坏按 0 处理，下一次获取即从 1 开始。
fn current_lease_token(path: &Path) -> u64 {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<LockPayload>(&bytes).ok())
        .map(|payload| payload.lease_token)
        .unwrap_or(0)
}

/// 获取库锁；抢不到返回 `VaultError::Readonly`，调用方据此进入只读观察者模式。
#[cfg(test)]
pub fn acquire(root: &Path, vault_id: &str) -> VaultResult<VaultLock> {
    acquire_detailed(root, vault_id).map_err(AcquireFailure::into_error)
}

/// 获取库锁并保留只读原因，供 `vault_identity` 与前端文案区分「谁占了锁」。
pub fn acquire_detailed(
    root: &Path,
    vault_id: &str,
) -> Result<VaultLock, AcquireFailure> {
    let path = paths::lock_file(root);
    fs::create_dir_all(paths::workbench(root)).map_err(VaultError::from)?;
    let machine_id = machine_id()?;

    match create(&path, vault_id, &machine_id, current_lease_token(&path) + 1) {
        Ok(lock) => Ok(lock),
        Err(VaultError::Readonly) => {
            let stale = match staleness(&path) {
                Ok(Staleness::Active) => {
                    return Err(AcquireFailure::Readonly(ReadonlyReason::LockedByOther));
                }
                Ok(Staleness::Stalled) => {
                    return Err(AcquireFailure::Readonly(ReadonlyReason::LockedByStalled));
                }
                Ok(Staleness::Stale(value)) => value,
                // 判定与读取之间锁被移除：本轮放弃；下次 acquire 会在空路径上直接创建。
                Err(VaultError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(AcquireFailure::Readonly(ReadonlyReason::ClaimFailed));
                }
                Err(error) => return Err(AcquireFailure::Error(error)),
            };
            // journal 恢复由 Vault::open 在拿到锁之后执行。
            let Some(claimed) = claim_stale(root, &stale)? else {
                return Err(AcquireFailure::Readonly(ReadonlyReason::ClaimFailed));
            };
            // 认领成功后锁路径为空；代次在认领值上 +1，保证接管者严格更大。
            // 若创建失败，说明有别的实例抢先，失效副本已无意义，清理后按只读返回。
            let created = create(&path, vault_id, &machine_id, claimed.lease_token + 1);
            let _ = fs::remove_file(&claimed.temp);
            created.map_err(|error| match error {
                VaultError::Readonly => AcquireFailure::Readonly(ReadonlyReason::ClaimFailed),
                other => AcquireFailure::Error(other),
            })
        }
        Err(error) => Err(AcquireFailure::Error(error)),
    }
}

fn create(
    path: &Path,
    vault_id: &str,
    machine_id: &str,
    lease_token: u64,
) -> VaultResult<VaultLock> {
    create_with_interval(path, vault_id, machine_id, lease_token, HEARTBEAT_INTERVAL)
}

fn create_with_interval(
    path: &Path,
    vault_id: &str,
    machine_id: &str,
    lease_token: u64,
    interval: Duration,
) -> VaultResult<VaultLock> {
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
        heartbeat_at: clock::now_iso8601(),
        lease_token,
        app: APP_VERSION.to_string(),
    };
    let bytes = serde_json::to_vec(&payload)?;
    handle.write_all(&bytes)?;
    handle.sync_all()?;
    drop(handle);

    let stop = Arc::new(AtomicBool::new(false));
    let healthy = Arc::new(AtomicBool::new(true));
    let heartbeat_at = Arc::new(Mutex::new(payload.heartbeat_at.clone()));
    let heartbeat = spawn_heartbeat(
        path.to_path_buf(),
        payload,
        Arc::clone(&stop),
        Arc::clone(&healthy),
        Arc::clone(&heartbeat_at),
        interval,
    );

    Ok(VaultLock {
        path: path.to_path_buf(),
        pid,
        lease_token,
        stop,
        healthy,
        heartbeat,
        heartbeat_at,
    })
}

fn spawn_heartbeat(
    path: PathBuf,
    mut payload: LockPayload,
    stop: Arc<AtomicBool>,
    healthy: Arc<AtomicBool>,
    heartbeat_at: Arc<Mutex<String>>,
    interval: Duration,
) -> Option<JoinHandle<()>> {
    thread::Builder::new()
        .name("ember-vault-lock".to_string())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                // 心跳间隔切片等待：Drop 需要 join 本线程，整段 sleep 会让
                // 退出最多阻塞 HEARTBEAT_INTERVAL；切成 250ms 步进随时可中断
                let mut remaining = interval;
                while remaining > Duration::ZERO && !stop.load(Ordering::Relaxed) {
                    let step = remaining.min(HEARTBEAT_STEP);
                    thread::sleep(step);
                    remaining -= step;
                }
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                // 持有权校验：锁文件已被其它实例覆盖（心跳失败后锁被按 stale 抢走）
                // 或已丢失 → 本实例立即放弃写权限，不再与他方心跳互相覆盖。
                match fs::read(&path) {
                    Ok(bytes) => {
                        if !lock_is_owned(&bytes, payload.pid, payload.lease_token) {
                            eprintln!("库锁已被其它实例接管，本实例降级为只读");
                            healthy.store(false, Ordering::Relaxed);
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        eprintln!("库锁文件丢失，本实例降级为只读");
                        healthy.store(false, Ordering::Relaxed);
                        break;
                    }
                    Err(_) => {}
                }
                // 心跳写入与 verify_lease 共用同一把锁：校验方不会读到
                // 「内存已更新、文件还是旧值」的中间态，避免误判租约失守。
                let mut stamp = heartbeat_at
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                payload.heartbeat_at = clock::now_iso8601();
                match serde_json::to_vec(&payload) {
                    Ok(bytes) => {
                        // 瞬时失败（如 temp 被并发的启动清扫撞上）先重试一次；
                        // 持续失败才降级只读，避免可恢复的抖动误杀写权限。
                        let first = atomic::write_atomic(&path, &bytes);
                        let ok = match first {
                            Ok(()) => true,
                            Err(_) => atomic::write_atomic(&path, &bytes).is_ok(),
                        };
                        if !ok {
                            eprintln!("库锁心跳写入失败，本实例降级为只读");
                            healthy.store(false, Ordering::Relaxed);
                            break;
                        }
                        *stamp = payload.heartbeat_at.clone();
                    }
                    Err(error) => {
                        eprintln!("库锁心跳序列化失败，本实例降级为只读：{error}");
                        healthy.store(false, Ordering::Relaxed);
                        break;
                    }
                }
            }
        })
        .map_err(|error| {
            eprintln!("库锁心跳线程启动失败：{error}");
            error
        })
        .ok()
}

/// 锁文件内容是否仍归本进程所有（pid + 租约代次都匹配且可解析）。
fn lock_is_owned(bytes: &[u8], pid: u32, lease_token: u64) -> bool {
    serde_json::from_slice::<LockPayload>(bytes)
        .map(|current| current.pid == pid && current.lease_token == lease_token)
        .unwrap_or(false)
}

/// 失效锁判定结果：携带判定瞬间的原始字节，接管时用来核对认领到的确实是同一份。
struct StaleLock {
    bytes: Vec<u8>,
    /// 载荷无法解析（半截/损坏）时按 0 处理
    lease_token: u64,
}

enum Staleness {
    Active,
    /// 心跳超龄但本机持有进程仍存活：只读等待，不抢锁
    Stalled,
    Stale(StaleLock),
}

/// 失效判定：心跳（文件 mtime）超过 30 秒，或同机且 pid 已不存在。
/// 先读内容再读 mtime：若文件在这两步之间被替换，读到的 mtime 属于新文件，
/// 只会让我们更保守地判为活跃锁，不会把新锁误判成失效。
fn staleness(path: &Path) -> VaultResult<Staleness> {
    staleness_at(path, SystemTime::now(), &machine_id()?)
}

/// `staleness` 的时钟与本机标识都显式传入，便于单测覆盖时钟跳变。
fn staleness_at(path: &Path, now: SystemTime, machine_id: &str) -> VaultResult<Staleness> {
    let bytes = fs::read(path)?;
    let aged = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| now.duration_since(modified).ok())
        .map(|age| age > STALE_AFTER)
        .unwrap_or(false);

    let payload = serde_json::from_slice::<LockPayload>(&bytes).ok();
    if aged {
        // 超龄不等于失效：同机进程仍存活说明只是心跳停了（挂起或时钟前跳），
        // 判为 Stalled 保持只读。抢锁会造成双写，而「关掉另一个实例」是可恢复的提示。
        if let Some(payload) = payload.as_ref() {
            if payload.machine_id == machine_id && pid_state(payload.pid) == Some(true) {
                return Ok(Staleness::Stalled);
            }
        }
        let lease_token = payload.map(|value| value.lease_token).unwrap_or(0);
        return Ok(Staleness::Stale(StaleLock { bytes, lease_token }));
    }
    let Some(payload) = payload else {
        // 半截或损坏的锁文件无法证明持有者存活，按失效处理以恢复可用性。
        return Ok(Staleness::Stale(StaleLock { bytes, lease_token: 0 }));
    };
    if payload.machine_id != machine_id || pid_alive(payload.pid) {
        return Ok(Staleness::Active);
    }
    Ok(Staleness::Stale(StaleLock {
        bytes,
        lease_token: payload.lease_token,
    }))
}

/// 认领后的失效锁：临时副本在接管结束（无论成败）后都要清理。
struct ClaimedStale {
    lease_token: u64,
    temp: PathBuf,
}

/// 原子认领失效锁：rename 到同目录的临时名，再回读确认仍是判定时那一份。
/// 并发接管只有一个 rename 成功；返回 None 表示锁已被别人认领或替换。
fn claim_stale(root: &Path, stale: &StaleLock) -> VaultResult<Option<ClaimedStale>> {
    let lock = paths::lock_file(root);
    let temp = paths::workbench(root).join(format!(
        "{TAKEOVER_PREFIX}{}.{}.{}",
        std::process::id(),
        stale.lease_token,
        TAKEOVER_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::rename(&lock, &temp) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    // rename 保留原锁文件的 mtime（可能已是几天前）：刷新为认领时刻，
    // 清扫的年龄门槛才等价于「认领后从未完成」，不会碰到正在进行的认领。
    if let Ok(file) = fs::OpenOptions::new().write(true).open(&temp) {
        let _ = file.set_modified(SystemTime::now());
    }

    let same = fs::read(&temp)
        .map(|bytes| bytes == stale.bytes)
        .unwrap_or(false);
    if same {
        return Ok(Some(ClaimedStale {
            lease_token: stale.lease_token,
            temp,
        }));
    }

    // 认领到的其实是判定之后才写入的新锁：用硬链接原位放回。
    // 硬链接在目标已存在时原子失败，不会覆盖期间新建的锁；放不回说明已有新持有者，
    // 副本直接丢弃，对方会因锁文件不符而自行降级只读。
    let _ = fs::hard_link(&temp, &lock);
    let _ = fs::remove_file(&temp);
    Ok(None)
}

/// pid 探测的三态：`Some(true/false)` 是确定结果，`None` 表示无法判断（命令不可用）。
fn pid_state(pid: u32) -> Option<bool> {
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .ok()
        .map(|status| status.success())
}

fn pid_alive(pid: u32) -> bool {
    // 无 libc 依赖：用 kill -0 探测。命令不可用时保守视为存活，避免误抢锁。
    pid_state(pid).unwrap_or(true)
}

fn machine_id() -> VaultResult<String> {
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
            let nanos = SystemTime::now()
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

    fn forged(pid: u32, lease_token: u64) -> LockPayload {
        LockPayload {
            vault_id: TEST_VAULT.to_string(),
            pid,
            machine_id: machine_id().unwrap(),
            started_at: clock::now_iso8601(),
            heartbeat_at: clock::now_iso8601(),
            lease_token,
            app: "0.0.0".to_string(),
        }
    }

    /// 同机、pid 已消失的新鲜锁：mtime 新，只能靠 pid 探测判定 stale。
    fn write_dead_lock(path: &Path, lease_token: u64) {
        let payload = forged(999_999_999, lease_token);
        fs::write(path, serde_json::to_vec(&payload).unwrap()).unwrap();
    }

    #[test]
    fn stale_takeover_increments_lease_token() {
        let temp = TempRoot::new("lock-lease");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        write_dead_lock(&path, 7);

        let lock = acquire(&temp.0, TEST_VAULT).unwrap();
        let payload: LockPayload = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(payload.lease_token, 8, "接管后的代次必须严格递增");
        assert_eq!(payload.pid, std::process::id());
        assert!(lock.verify_lease(), "新持有者的租约应通过校验");

        drop(lock);
        assert!(!path.exists(), "Drop 应只删除自己的租约");
    }

    #[test]
    fn concurrent_takeover_has_exactly_one_winner() {
        let temp = TempRoot::new("lock-race");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        write_dead_lock(&path, 3);

        let root = temp.0.clone();
        let results = thread::scope(|scope| {
            let first = scope.spawn(|| acquire(&root, TEST_VAULT));
            let second = scope.spawn(|| acquire(&root, TEST_VAULT));
            [first.join().unwrap(), second.join().unwrap()]
        });

        assert_eq!(
            results.iter().filter(|result| result.is_ok()).count(),
            1,
            "并发接管只能有一个实例拿到租约"
        );
        assert!(
            results
                .iter()
                .any(|result| matches!(result, Err(VaultError::Readonly))),
            "没抢到租约的实例必须得到只读，而不是第二把锁"
        );
    }

    #[test]
    fn claim_restores_lock_replaced_after_staleness_check() {
        let temp = TempRoot::new("lock-replaced");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        write_dead_lock(&path, 2);

        let stale = match staleness(&path).unwrap() {
            Staleness::Stale(value) => value,
            Staleness::Active => panic!("伪造的死锁应判定为失效"),
            Staleness::Stalled => panic!("pid 已死，不应判为心跳停摆"),
        };

        // 判定之后、rename 之前，另一个实例写入了一把新的活跃锁
        let live = forged(std::process::id(), 9);
        let live_bytes = serde_json::to_vec(&live).unwrap();
        fs::write(&path, &live_bytes).unwrap();

        assert!(
            claim_stale(&temp.0, &stale).unwrap().is_none(),
            "内容已变时不得认领"
        );
        assert_eq!(
            fs::read(&path).unwrap(),
            live_bytes,
            "别人的新锁必须原位放回，不能丢失"
        );
    }

    #[test]
    fn crash_after_claim_still_allows_next_instance() {
        let temp = TempRoot::new("lock-crash");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        write_dead_lock(&path, 5);

        // 模拟接管者 rename 之后、create 之前崩溃：锁路径为空，临时副本留在 .workbench
        let orphan = paths::workbench(&temp.0).join(format!("lock.takeover.{}.5.0", std::process::id()));
        fs::rename(&path, &orphan).unwrap();
        assert!(!path.exists());

        let lock = acquire(&temp.0, TEST_VAULT).expect("锁路径为空时后续实例应能正常获取");
        let payload: LockPayload = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(payload.pid, std::process::id());
        assert_eq!(payload.lease_token, 1, "空路径按缺失处理，从 1 开始");
        drop(lock);
    }

    #[test]
    fn claim_refreshes_copy_mtime_so_sweep_cannot_kill_it() {
        let temp = TempRoot::new("lock-claim-age");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        write_dead_lock(&path, 4);
        // 认领会把原锁文件的旧 mtime 带到副本上，若不刷新，清扫会立刻判它超龄
        let old = fs::OpenOptions::new().write(true).open(&path).unwrap();
        old.set_modified(SystemTime::now() - Duration::from_secs(48 * 3600))
            .unwrap();
        drop(old);

        let stale = match staleness(&path).unwrap() {
            Staleness::Stale(value) => value,
            Staleness::Active => panic!("伪造的死锁应判定为失效"),
            Staleness::Stalled => panic!("pid 已死，不应判为心跳停摆"),
        };
        let claimed = claim_stale(&temp.0, &stale).unwrap().expect("应能认领");

        let age = SystemTime::now()
            .duration_since(fs::metadata(&claimed.temp).unwrap().modified().unwrap())
            .unwrap();
        assert!(age < Duration::from_secs(60), "认领副本的 mtime 必须刷新为当前");
    }

    #[test]
    fn aged_lock_with_live_local_pid_is_stalled() {
        let temp = TempRoot::new("lock-stalled");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let payload = forged(std::process::id(), 3);
        fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        drop(file);

        assert!(matches!(
            staleness_at(&path, SystemTime::now(), &payload.machine_id).unwrap(),
            Staleness::Stalled
        ));
        assert!(
            matches!(acquire(&temp.0, TEST_VAULT), Err(VaultError::Readonly)),
            "本机进程仍存活时只能只读等待，不能抢锁"
        );
    }

    #[test]
    fn aged_lock_with_dead_pid_stays_stale() {
        let temp = TempRoot::new("lock-stale-dead");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let payload = forged(999_999_999, 4);
        fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(60))
            .unwrap();
        drop(file);

        assert!(matches!(
            staleness_at(&path, SystemTime::now(), &payload.machine_id).unwrap(),
            Staleness::Stale(_)
        ));
    }

    #[test]
    fn clock_rollback_keeps_foreign_lock_active() {
        let temp = TempRoot::new("lock-rollback");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let mut payload = forged(999_999_999, 5);
        payload.machine_id = "01JOTHERMACHINE0000000000".to_string();
        fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
        // mtime 在未来：系统时钟回拨后的表现
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(60))
            .unwrap();
        drop(file);

        assert!(matches!(
            staleness_at(&path, SystemTime::now(), &machine_id().unwrap()).unwrap(),
            Staleness::Active
        ));
    }

    #[test]
    fn verify_lease_ignores_concurrent_heartbeat_writes() {
        let temp = TempRoot::new("lock-verify");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();
        let machine = machine_id().unwrap();
        let lock = create_with_interval(&path, TEST_VAULT, &machine, 1, Duration::from_millis(1))
            .unwrap();

        for _ in 0..5_000 {
            assert!(lock.verify_lease(), "心跳写入期间不得误判租约失守");
        }
        drop(lock);
    }

    #[test]
    fn takeover_copy_names_are_matched_strictly() {
        assert!(is_takeover_copy("lock.takeover.100.7.0"));
        assert!(!is_takeover_copy("lock.takeover.md"));
        assert!(!is_takeover_copy("lock.takeover.100.7"));
        assert!(!is_takeover_copy("lock.takeover.100.7.0.extra"));
        assert!(!is_takeover_copy(".lock"));
        assert!(!is_takeover_copy("lock.takeover..7.0"));
    }

    #[test]
    fn active_lock_is_never_taken_over() {
        let temp = TempRoot::new("lock-active");
        let held = acquire(&temp.0, TEST_VAULT).unwrap();

        let second = acquire(&temp.0, TEST_VAULT);
        assert!(
            matches!(second, Err(VaultError::Readonly)),
            "活跃锁必须拒绝，不能因接管逻辑而放宽"
        );

        drop(held);
    }
}
