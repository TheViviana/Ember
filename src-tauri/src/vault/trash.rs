//! macOS 系统回收站适配层（vault-format §8.3）。
//!
//! 用户删除的落点依次为：`NSFileManager.trashItemAtURL`（系统回收站）→ Finder 代删
//! （`osascript`，落点同样是系统回收站）→ 库内 `.workbench/trash/<ULID>/`（30 天后
//! 启动清扫回收）。任何路径都不调用 `fs::remove_file`，不会永久删除；非 macOS 平台明确失败。
//!
//! `unsafe` 只允许出现在本文件：objc2 的 FFI 边界集中在这里，每处都写明前置条件。

#[cfg(target_os = "macos")]
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{VaultError, VaultResult};

#[cfg(target_os = "macos")]
use super::paths;



/// 删除落点：system = 系统回收站；internal = 库内回收目录（30 天后启动清扫回收）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashDestination {
    System,
    Internal,
}

impl TrashDestination {
    pub fn as_str(self) -> &'static str {
        match self {
            TrashDestination::System => "system",
            TrashDestination::Internal => "internal",
        }
    }
}

/// 用户删除的唯一入口：优先系统回收站；系统回收站不可用时降级为库内回收目录。
///
/// 常见降级场景：库在 `~/Documents` 下时，macOS 只授予了文稿目录的 TCC 权限，
/// 而系统回收站要写 `~/.Trash`——同一授权域之外，`trashItemAtURL` 会报
/// 「you don't have permission to access it」。降级动作是库内的普通 rename
/// （`.workbench/trash/<ULID>/`，30 天后由启动清扫回收），不需要任何额外权限，
/// 文件同样可找回，绝不静默永久删除。
pub fn trash(root: &Path, absolute: &Path) -> VaultResult<TrashDestination> {
    #[cfg(target_os = "macos")]
    {
        // 1) NSFileManager：有 ~/.Trash 写权限（全盘授权、或库不在 TCC 域内）时最快
        if trash_system(root, absolute).is_ok() {
            return Ok(TrashDestination::System);
        }
        // 2) Finder 代删：只有「文稿」授权的库（如 ~/Documents/EmberVault）写不了
        //    ~/.Trash，但有全盘权限的 Finder 可以——macOS 标准绕行，首次会请求
        //    「控制 Finder」的自动化授权。落点同样是系统回收站。
        if trash_via_finder(absolute).is_ok() {
            return Ok(TrashDestination::System);
        }
        // 3) 库内回收目录：前两者都不可用时兜底（30 天后启动清扫回收，可找回）
        trash_internal(root, absolute).map(|()| TrashDestination::Internal)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // 非 macOS：无系统回收站 API，保持既有契约——明确拒绝，绝不永久删除
        let _ = (root, absolute);
        Err(VaultError::IoAt {
            path: absolute.display().to_string(),
            message: "当前平台不支持系统回收站，删除被拒绝（不会永久删除文件）".to_string(),
        })
    }
}

/// 目录删除专用：只进系统回收站，系统回收站不可用即失败。
///
/// 与 [`trash`] 的区别只有一点：绝不降级到库内回收目录。目录删除会把整棵子树
/// 一起移走，落点必须是用户能在系统回收站里一眼找到、可整体还原的地方；
/// 库内回收目录（30 天后启动清扫）不适合承载这类批量删除，失败就保持原样。
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

/// 降级落点：库内回收目录 `.workbench/trash/<ULID>/<文件名>`。
/// 普通 rename，不依赖任何 TCC 授权；30 天后由启动清扫（sweep_expired_trash）回收。
#[cfg(target_os = "macos")]
fn trash_internal(root: &Path, absolute: &Path) -> VaultResult<()> {
    let ulid = crate::vault::ulid::generate();
    let dir = root.join(paths::WORKBENCH_DIR).join("trash").join(&ulid);
    fs::create_dir_all(&dir).map_err(|error| io_at(&dir, &error.to_string()))?;
    let file_name = absolute
        .file_name()
        .ok_or_else(|| VaultError::PathOutside(absolute.display().to_string()))?;
    let target = dir.join(file_name);
    fs::rename(absolute, &target).map_err(|error| io_at(absolute, &error.to_string()))?;
    // 校验：源已消失、落点存在（与系统回收站同一验收口径）
    if symlink_metadata_ok(absolute) {
        return Err(io_at(
            absolute,
            "库内回收目录移动后源文件仍在库内",
        ));
    }
    if !target.is_file() {
        return Err(io_at(
            absolute,
            "库内回收目录落点不存在，无法确认删除结果",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn symlink_metadata_ok(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
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

    #[test]
    fn internal_trash_fallback_moves_file_into_workbench_trash() {
        let seq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let root = std::env::temp_dir().join(format!("ember-trash-{}-{seq}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("media").join("aa").join("test.png");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"png").unwrap();

        trash_internal(&root, &file).unwrap();

        // 源消失
        assert!(!file.exists());
        // 落点在库内回收目录：.workbench/trash/<ULID>/test.png
        let trash_dir = root.join(paths::WORKBENCH_DIR).join("trash");
        let mut entries = std::fs::read_dir(&trash_dir).unwrap();
        let entry = entries.next().unwrap().unwrap();
        let restored = entry.path().join("test.png");
        assert!(restored.is_file(), "落点应存在：{}", restored.display());
        assert!(std::fs::read(&restored).unwrap() == b"png");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
