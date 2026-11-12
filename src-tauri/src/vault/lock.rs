use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
        let expected = self
            .heartbeat_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let bytes = match fs::read(&self.path) {
            Ok(value) => value,
            Err(_) => return false,
        };
        match serde_json::from_slice::<LockPayload>(&bytes) {
            Ok(current) => {
                current.pid == self.pid
                    && current.lease_token == self.lease_token
                    && current.heartbeat_at == expected
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
pub fn acquire(root: &Path, vault_id: &str) -> VaultResult<VaultLock> {
    let path = paths::lock_file(root);
    fs::create_dir_all(paths::workbench(root))?;
    let machine_id = machine_id()?;

    match create(&path, vault_id, &machine_id, current_lease_token(&path) + 1) {
        Ok(lock) => Ok(lock),
        Err(VaultError::Readonly) => {
            if !is_stale(&path)? {
                return Err(VaultError::Readonly);
            }
            // 失效锁：先移除再抢占；journal 恢复由 Vault::open 在拿到锁之后执行。
            // 代次在删除前重读，保证接管者写入的是严格更大的值。
            let token = current_lease_token(&path) + 1;
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            create(&path, vault_id, &machine_id, token)
        }
        Err(error) => Err(error),
    }
}

fn create(
    path: &Path,
    vault_id: &str,
    machine_id: &str,
    lease_token: u64,
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
) -> Option<JoinHandle<()>> {
    thread::Builder::new()
        .name("ember-vault-lock".to_string())
        .spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                // 心跳间隔切片等待：Drop 需要 join 本线程，整段 sleep 会让
                // 退出最多阻塞 HEARTBEAT_INTERVAL；切成 250ms 步进随时可中断
                let mut remaining = HEARTBEAT_INTERVAL;
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

/// 失效判定：心跳（文件 mtime）超过 30 秒，或同机且 pid 已不存在。
fn is_stale(path: &Path) -> VaultResult<bool> {
    let metadata = std::fs::metadata(path)?;
    if let Ok(modified) = metadata.modified() {
        if SystemTime::now()
            .duration_since(modified)
            .map(|age| age > STALE_AFTER)
            .unwrap_or(false)
        {
            return Ok(true);
        }
    }

    let bytes = fs::read(path)?;
    let payload: LockPayload = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        // 半截或损坏的锁文件无法证明持有者存活，按失效处理以恢复可用性。
        Err(_) => return Ok(true),
    };
    if payload.machine_id != machine_id()? {
        return Ok(false);
    }
    Ok(!pid_alive(payload.pid))
}

fn pid_alive(pid: u32) -> bool {
    // 无 libc 依赖：用 kill -0 探测。命令不可用时保守视为存活，避免误抢锁。
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
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

    #[test]
    fn stale_takeover_increments_lease_token() {
        let temp = TempRoot::new("lock-lease");
        let path = paths::lock_file(&temp.0);
        fs::create_dir_all(paths::workbench(&temp.0)).unwrap();

        // 同机、pid 已消失的失效锁：mtime 新，只能靠 pid 探测判定 stale。
        let forged = LockPayload {
            vault_id: "01JTESTVAULT000000000000".to_string(),
            pid: 999_999_999,
            machine_id: machine_id().unwrap(),
            started_at: clock::now_iso8601(),
            heartbeat_at: clock::now_iso8601(),
            lease_token: 7,
            app: "0.0.0".to_string(),
        };
        fs::write(&path, serde_json::to_vec(&forged).unwrap()).unwrap();

        let lock = acquire(&temp.0, "01JTESTVAULT000000000000").unwrap();
        let payload: LockPayload = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(payload.lease_token, 8, "接管后的代次必须严格递增");
        assert_eq!(payload.pid, std::process::id());
        assert!(lock.verify_lease(), "新持有者的租约应通过校验");

        drop(lock);
        assert!(!path.exists(), "Drop 应只删除自己的租约");
    }
}
