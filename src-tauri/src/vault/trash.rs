//! macOS 系统回收站适配层（vault-format §8.3）。
//!
//! 用户删除的落点只有系统回收站：`NSFileManager.trashItemAtURL`，失败再让 Finder 代删
//! （`osascript`，落点同样是系统回收站）。**不降级到库内回收目录**——库可能位于
//! iCloud/Obsidian 目录，写进去会跟着同步并污染笔记目录。任何路径都不调用
//! `fs::remove_file`，不会永久删除；系统回收站不可用时删除直接失败，文件保持原样。
//!
//! `unsafe` 只允许出现在本文件：objc2 的 FFI 边界集中在这里，每处都写明前置条件。

use std::path::{Path, PathBuf};

use crate::error::{VaultError, VaultResult};

/// 删除落点。v1 只保留系统回收站；保留枚举是为了让「文件本就不存在」与
/// 「已移入回收站」在 IPC 上仍是两种可区分的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashDestination {
    System,
}

impl TrashDestination {
    pub fn as_str(self) -> &'static str {
        match self {
            TrashDestination::System => "system",
        }
    }
}

/// 用户删除的唯一入口：只进系统回收站，不可用即失败（不降级库内回收）。
pub fn trash(root: &Path, absolute: &Path) -> VaultResult<TrashDestination> {
    trash_system_only(root, absolute)?;
    Ok(TrashDestination::System)
}

/// 目录删除专用：与单文件删除用同一落点（系统回收站），不可用即失败。
///
/// 目录删除会把整棵子树一起移走，落点必须是用户能在系统回收站里一眼找到、可整体还原的地方；
/// 失败就保持原样，不拆成逐文件删除。
pub fn trash_system_only(root: &Path, absolute: &Path) -> VaultResult<()> {
    #[cfg(target_os = "macos")]
    {
        let system = trash_system(root, absolute);
        if system.is_ok() {
            return Ok(());
        }
        let finder = trash_via_finder(absolute);
        if finder.is_ok() {
            return Ok(());
        }
        let detail = match (system, finder) {
            (Err(system_error), Err(finder_error)) => {
                format!("：{system_error}；Finder 代删也失败：{finder_error}")
            }
            _ => String::new(),
        };
        Err(io_at(
            absolute,
            &format!("系统回收站不可用，文件夹保持原样{detail}"),
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        Err(io_at(
            absolute,
            "当前平台不支持系统回收站，文件夹删除被拒绝（不会降级为库内回收或永久删除）",
        ))
    }
}

/// 把 `absolute` 移入系统回收站，并校验转移结果。
///
/// 校验项（任一不满足即报错，源文件已无法回滚，但绝不留下「以为删了实际还在」的假象）：
/// 1. 源路径必须消失；
/// 2. 系统返回的 `resultingItemURL` 必须存在；
/// 3. 落点不得仍在库根内（防止 API 把文件挪进 `.workbench/` 之类的地方）。
#[cfg(target_os = "macos")]
fn trash_system(root: &Path, absolute: &Path) -> VaultResult<()> {
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

/// 让 Finder 代为入篓：Finder 持有全盘权限，能写入 `~/.Trash`。
/// 适用场景：应用只有「文稿」TCC 授权、`trashItemAtURL` 报权限不足的日常库。
/// 首次调用会触发一次「Ember 想控制 Finder」的自动化授权；拒绝则此路永久失败，
/// 上层自动落到库内回收目录。校验口径与系统回收站一致：源文件必须消失。
#[cfg(target_os = "macos")]
fn trash_via_finder(absolute: &Path) -> VaultResult<()> {
    // AppleScript 字符串转义：反斜杠与双引号（库内路径可含空格与 CJK，双引号包裹即可）
    let escaped = absolute
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "tell application \"Finder\" to delete (POSIX file \"{escaped}\" as alias)"
    );
    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|error| io_at(absolute, &format!("无法调用 Finder：{error}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(io_at(
            absolute,
            &format!("Finder 删除失败：{}", stderr.trim()),
        ));
    }
    // 校验：源文件必须已离开库内
    if std::fs::symlink_metadata(absolute).is_ok() {
        return Err(io_at(
            absolute,
            "Finder 调用成功，但源文件仍在库内",
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
