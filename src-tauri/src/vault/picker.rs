use tauri::AppHandle;

/// 目录选择：`allow_create` 为真时面板允许新建文件夹（新建库入口）。
/// 取消或平台不支持时返回 `None`。
#[cfg(target_os = "macos")]
pub fn choose_directory(app: &AppHandle, allow_create: bool) -> Option<String> {
    macos::choose(app, allow_create)
}

#[cfg(not(target_os = "macos"))]
pub fn choose_directory(_app: &AppHandle, _allow_create: bool) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::NSString;
    use tauri::AppHandle;

    /// 面板是模态的：等用户操作，超时只是防止异常情况下命令线程永远挂着。
    const PANEL_TIMEOUT: Duration = Duration::from_secs(600);

    pub fn choose(app: &AppHandle, allow_create: bool) -> Option<String> {
        let (sender, receiver) = mpsc::channel();
        let message = if allow_create {
            "选择一个空文件夹作为 Ember 库，或新建一个文件夹。"
        } else {
            "选择一个已有的库文件夹。"
        };
        let scheduled = app.run_on_main_thread(move || {
            // runModal 必须在主线程；拿不到主线程标记时只能放弃本次选择。
            let Some(marker) = MainThreadMarker::new() else {
                let _ = sender.send(None);
                return;
            };
            let panel = NSOpenPanel::new(marker);
            panel.setCanChooseFiles(false);
            panel.setCanChooseDirectories(true);
            panel.setAllowsMultipleSelection(false);
            panel.setCanCreateDirectories(allow_create);
            let prompt = NSString::from_str(if allow_create { "使用此文件夹" } else { "打开" });
            panel.setPrompt(Some(&prompt));
            let detail = NSString::from_str(message);
            panel.setMessage(Some(&detail));

            if panel.runModal() != NSModalResponseOK {
                let _ = sender.send(None);
                return;
            }
            let path = panel
                .URLs()
                .firstObject()
                .and_then(|url| url.path())
                .map(|text| text.to_string());
            let _ = sender.send(path);
        });

        if scheduled.is_err() {
            return None;
        }
        receiver.recv_timeout(PANEL_TIMEOUT).ok().flatten()
    }
}
