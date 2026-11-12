//! macOS 系统回收站适配层（vault-format §8.6）。
//!
//! 用户删除的唯一落点是 `NSFileManager.trashItemAtURL`：文件离开库目录后由系统接管，
//! 应用内不再保留任何副本。非 macOS 平台明确失败，**绝不**回退为 `fs::remove_file`。
//!
//! `unsafe` 只允许出现在本文件：objc2 的 FFI 边界集中在这里，每处都写明前置条件。

use std::path::{Path, PathBuf};

use crate::error::{VaultError, VaultResult};

/// 非 macOS：明确报错，而不是悄悄永久删除。
#[cfg(not(target_os = "macos"))]
pub fn trash(_root: &Path, absolute: &Path) -> VaultResult<()> {
    Err(VaultError::IoAt {
        path: absolute.display().to_string(),
        message: "当前平台不支持系统回收站，删除被拒绝（不会永久删除文件）".to_string(),
    })
}

/// 把 `absolute` 移入系统回收站，并校验转移结果。
///
/// 校验项（任一不满足即报错，源文件已无法回滚，但绝不留下「以为删了实际还在」的假象）：
/// 1. 源路径必须消失；
/// 2. 系统返回的 `resultingItemURL` 必须存在；
/// 3. 落点不得仍在库根内（防止 API 把文件挪进 `.workbench/` 之类的地方）。
#[cfg(target_os = "macos")]
pub fn trash(root: &Path, absolute: &Path) -> VaultResult<()> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSFileManager, NSNumber, NSString, NSURL, NSURLVolumeIsLocalKey};

    let url = NSURL::fileURLWithPath(&NSString::from_str(&absolute.to_string_lossy()));

    // 预检：非本地卷（网络盘/云盘）没有可用的系统回收站，直接拒绝，不调 trash API。
    let mut volume_value: Option<Retained<AnyObject>> = None;
    // SAFETY: getResourceValue:forKey:error: 只在成功时写入 out 参数；key 是 Foundation
    // 导出的静态常量；url 由本函数用绝对路径构造，存活期覆盖整个调用。
    match unsafe {
        url.getResourceValue_forKey_error(&mut volume_value, NSURLVolumeIsLocalKey)
    } {
        Ok(()) => {}
        Err(error) => {
            return Err(io_at(
                absolute,
                &format!("无法确认目标所在卷类型：{}", error.localizedDescription()),
            ));
        }
    }
    let is_local = volume_value
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .map(|number| number.boolValue());
    ensure_local_volume(is_local, absolute)?;

    let manager = NSFileManager::defaultManager();
    let mut resulting: Option<Retained<NSURL>> = None;
    if let Err(error) =
        manager.trashItemAtURL_resultingItemURL_error(&url, Some(&mut resulting))
    {
        return Err(io_at(
            absolute,
            &format!("移入系统回收站失败：{}", error.localizedDescription()),
        ));
    }

    match std::fs::symlink_metadata(absolute) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => {
            return Err(io_at(
                absolute,
                "系统回收站调用返回成功，但源文件仍在库内",
            ));
        }
        Err(error) => {
            return Err(io_at(
                absolute,
                &format!("无法确认源文件已移走：{error}"),
            ));
        }
    }

    let Some(resulting) = resulting else {
        return Err(io_at(absolute, "系统未返回回收站落点，无法确认删除结果"));
    };
    let Some(target) = resulting.path() else {
        return Err(io_at(
            absolute,
            "系统返回的回收站落点不是文件路径，无法确认删除结果",
        ));
    };
    let target = PathBuf::from(target.to_string());
    if std::fs::symlink_metadata(&target).is_err() {
        return Err(io_at(
            absolute,
            &format!("回收站落点不存在：{}", target.display()),
        ));
    }
    if is_inside(root, &target) {
        return Err(io_at(
            absolute,
            &format!("回收站落点仍在库内：{}", target.display()),
        ));
    }
    Ok(())
}

/// 卷类型裁决：拿不到结论时按失败处理（fail-closed），避免把库外文件误移。
#[cfg(target_os = "macos")]
fn ensure_local_volume(is_local: Option<bool>, absolute: &Path) -> VaultResult<()> {
    match is_local {
        Some(true) => Ok(()),
        Some(false) => Err(io_at(
            absolute,
            "目标位于非本地卷（网络盘/云盘），系统回收站不可用；文件保持原样",
        )),
        None => Err(io_at(
            absolute,
            "无法确认目标所在卷类型，为避免误删，删除被拒绝",
        )),
    }
}

/// 落点是否仍在库根内。任一路径无法规范化时按「在库内」处理，宁可报错也不放过。
#[cfg(target_os = "macos")]
fn is_inside(root: &Path, target: &Path) -> bool {
    let (Ok(root), Ok(target)) = (root.canonicalize(), target.canonicalize()) else {
        return true;
    };
    target.starts_with(root)
}

#[cfg(target_os = "macos")]
fn io_at(absolute: &Path, message: &str) -> VaultError {
    VaultError::IoAt {
        path: absolute.display().to_string(),
        message: message.to_string(),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn non_local_volume_is_rejected_before_trash_api() {
        let error = ensure_local_volume(Some(false), Path::new("/tmp/x.md")).unwrap_err();
        assert!(matches!(error, VaultError::IoAt { .. }));
        assert!(error.to_string().contains("非本地卷"), "文案应说明原因：{error}");
    }

    #[test]
    fn unknown_volume_type_fails_closed() {
        let error = ensure_local_volume(None, Path::new("/tmp/x.md")).unwrap_err();
        assert!(error.to_string().contains("无法确认"), "文案应说明原因：{error}");
    }

    #[test]
    fn local_volume_passes_precheck() {
        ensure_local_volume(Some(true), Path::new("/tmp/x.md")).unwrap();
    }
}
