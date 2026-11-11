use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
    pub app: String,
}

/// 持有的库锁。Drop 时停止心跳并删除自己写入的锁文件。
pub struct VaultLock {
    path: PathBuf,
    pid: u32,
    stop: Arc<AtomicBool>,
    /// 心跳健康标志：锁被其它实例接管、锁文件丢失或心跳写失败时翻 false，
    /// 持有方据此把运行态降级为只读，避免「心跳已死仍在写」的双写者窗口。
    healthy: Arc<AtomicBool>,
    heartbeat: Option<JoinHandle<()>>,
}

impl VaultLock {
    /// 共享健康标志：false = 心跳已判定锁失守（被接管/写失败），持有方必须停止一切写操作。
    /// 供 Vault 在 ensure_writable 里实时检查。
    pub fn health_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.healthy)
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
                if payload.pid == self.pid {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

/// 获取库锁；抢不到返回 `VaultError::Readonly`，调用方据此进入只读观察者模式。
pub fn acquire(root: &Path, vault_id: &str) -> VaultResult<VaultLock> {
    let path = paths::lock_file(root);
    fs::create_dir_all(paths::workbench(root))?;
    let machine_id = machine_id()?;

    match create(&path, vault_id, &machine_id) {
        Ok(lock) => Ok(lock),
        Err(VaultError::Readonly) => {
            if !is_stale(&path)? {
                return Err(VaultError::Readonly);
            }
            // 失效锁：先移除再抢占；journal 恢复由 Vault::open 在拿到锁之后执行。
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            create(&path, vault_id, &machine_id)
        }
        Err(error) => Err(error),
    }
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
        heartbeat_at: clock::now_iso8601(),
        app: APP_VERSION.to_string(),
    };
    let bytes = serde_json::to_vec(&payload)?;
    handle.write_all(&bytes)?;
    handle.sync_all()?;
    drop(handle);

    let stop = Arc::new(AtomicBool::new(false));
    let healthy = Arc::new(AtomicBool::new(true));
    let heartbeat = spawn_heartbeat(path.to_path_buf(), payload, Arc::clone(&stop), Arc::clone(&healthy));

    Ok(VaultLock {
        path: path.to_path_buf(),
        pid,
        stop,
        healthy,
        heartbeat,
    })
}

fn spawn_heartbeat(
    path: PathBuf,
    mut payload: LockPayload,
    stop: Arc<AtomicBool>,
    healthy: Arc<AtomicBool>,
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
                        if !lock_is_owned(&bytes, payload.pid) {
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

/// 锁文件内容是否仍归本进程所有（pid 匹配且可解析）。
fn lock_is_owned(bytes: &[u8], pid: u32) -> bool {
    serde_json::from_slice::<LockPayload>(bytes)
        .map(|current| current.pid == pid)
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
