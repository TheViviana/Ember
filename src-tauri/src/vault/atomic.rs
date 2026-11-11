use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::VaultResult;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 已 fsync 的临时文件句柄；rename 之前崩溃时，磁盘上只剩它和完整旧目标。
pub struct TempFile {
    pub path: PathBuf,
    pub target: PathBuf,
}

impl TempFile {
    pub fn relative_to(&self, root: &Path) -> Option<String> {
        self.path
            .strip_prefix(root)
            .ok()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
    }
}

fn temp_path(target: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "entry".to_string());
    let temp = format!(".{name}.ember-tmp-{nanos}-{counter}");
    match target.parent() {
        Some(parent) => parent.join(temp),
        None => PathBuf::from(temp),
    }
}

fn sync_dir(dir: &Path) -> VaultResult<()> {
    // 目录 fsync 让 rename 持久化；个别文件系统不支持时直接传播错误，避免静默丢失持久性。
    let handle = File::open(dir)?;
    handle.sync_all()?;
    Ok(())
}

/// 第一步：同目录写临时文件并 fsync，目标文件保持不变。
pub fn prepare(target: &Path, bytes: &[u8]) -> VaultResult<TempFile> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let path = temp_path(target);
    {
        let mut handle = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        handle.write_all(bytes)?;
        handle.sync_all()?;
    }
    Ok(TempFile {
        path,
        target: target.to_path_buf(),
    })
}

/// 第二步：rename + 目录 fsync。调用方必须先持久化 journal 的 prepared 阶段。
pub fn commit(temp: &TempFile) -> VaultResult<()> {
    fs::rename(&temp.path, &temp.target)?;
    if let Some(parent) = temp.target.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

/// 一步到位的原子写（settings、锁心跳等不需要 journal 的内部文件）。
pub fn write_atomic(target: &Path, bytes: &[u8]) -> VaultResult<()> {
    let temp = prepare(target, bytes)?;
    commit(&temp)
}
