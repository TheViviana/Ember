use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{VaultError, VaultResult};

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

/// 把已存在目标的权限位复制到刚创建的临时文件；目标不存在时保持 umask 语义。
///
/// 必须在 temp 创建之后、写入内容之前调用：chmod 前的窗口里临时文件内容为空，
/// 不会以 umask 默认权限承载原本受保护的内容。
#[cfg(unix)]
fn inherit_mode(target: &Path, temp: &Path) -> VaultResult<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = match fs::metadata(target) {
        Ok(metadata) => metadata.permissions().mode() & 0o7777,
        // 竞态：目标在创建 temp 与读元数据之间被删，按新建处理。
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(VaultError::IoAt {
                path: target.display().to_string(),
                message: format!("原子写无法读取原文件权限位：{error}"),
            })
        }
    };
    fs::set_permissions(temp, fs::Permissions::from_mode(mode)).map_err(|error| VaultError::IoAt {
        path: temp.display().to_string(),
        message: format!("原子写复制原文件权限位 0o{mode:o} 失败：{error}"),
    })
}

#[cfg(not(unix))]
fn inherit_mode(_target: &Path, _temp: &Path) -> VaultResult<()> {
    Ok(())
}

/// 第一步：同目录写临时文件并 fsync，目标文件保持不变。
pub fn prepare(target: &Path, bytes: &[u8]) -> VaultResult<TempFile> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let path = temp_path(target);
    let mut handle = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)?;
    // 顺序固定：create_new → 复制权限位 → 写内容 → 再复制权限位 → fsync。
    // 第一次 chmod 在写入之前，保证内容不会以 umask 默认权限短暂暴露；
    // POSIX 在写入时会清除 setuid/setgid，故写入后需要补一次。
    // 任何一步失败都删除临时文件，避免留下孤儿 temp。
    let result = inherit_mode(target, &path)
        .and_then(|()| handle.write_all(bytes).map_err(VaultError::from))
        .and_then(|()| inherit_mode(target, &path))
        .and_then(|()| handle.sync_all().map_err(VaultError::from));
    if let Err(error) = result {
        drop(handle);
        let _ = fs::remove_file(&path);
        return Err(error);
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

#[cfg(all(test, unix))]
mod tests {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    /// 并行测试的临时目录名不能只靠纳秒时间戳：macOS 时钟粒度内可能重名。
    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempDir {
        root: PathBuf,
    }

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ember-atomic-{tag}-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[test]
    fn replace_keeps_0600() {
        let dir = TempDir::new("perm-0600");
        let target = dir.root.join("a.md");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();

        write_atomic(&target, b"new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(mode_of(&target), 0o600, "原子替换把 0600 重置为 umask 默认值");
    }

    #[test]
    fn replace_keeps_0644() {
        let dir = TempDir::new("perm-0644");
        let target = dir.root.join("a.md");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();

        write_atomic(&target, b"new").unwrap();

        assert_eq!(mode_of(&target), 0o644, "本来就宽的权限不应被收窄");
    }

    #[test]
    fn replace_keeps_special_bits() {
        let dir = TempDir::new("perm-special");
        let target = dir.root.join("a.md");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o4600)).unwrap();

        write_atomic(&target, b"new").unwrap();

        assert_eq!(mode_of(&target), 0o4600, "setuid/setgid/sticky 位同样应被复制");
    }

    #[test]
    fn new_file_follows_umask() {
        let dir = TempDir::new("perm-new");
        // 参照文件走同一 umask 的普通创建，避免测试机 umask 差异导致硬编码失败。
        let reference = dir.root.join("reference");
        fs::write(&reference, b"ref").unwrap();
        let target = dir.root.join("a.md");

        write_atomic(&target, b"new").unwrap();

        assert_eq!(
            mode_of(&target),
            mode_of(&reference),
            "目标不存在时必须保持 umask 语义，而不是被强制改成 0600"
        );
        assert_eq!(mode_of(&target) & 0o600, 0o600, "新建文件至少对属主可读写");
    }

    #[test]
    fn setgid_directory_does_not_leak_into_file_mode() {
        let dir = TempDir::new("perm-setgid");
        fs::set_permissions(&dir.root, fs::Permissions::from_mode(0o2755)).unwrap();
        let reference = dir.root.join("reference");
        fs::write(&reference, b"ref").unwrap();
        let target = dir.root.join("a.md");

        write_atomic(&target, b"new").unwrap();

        assert_eq!(
            mode_of(&target) & 0o777,
            mode_of(&reference) & 0o777,
            "setgid 目录下新建文件的权限仍由 umask 决定"
        );
        assert_eq!(mode_of(&target) & 0o2000, 0, "目录的 setgid 位不应出现在文件上");
    }
}
