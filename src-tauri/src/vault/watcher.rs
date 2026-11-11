use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::vault::paths;

const POLL_INTERVAL: Duration = Duration::from_millis(1200);
/// 轮询等待的切片步长：Drop join 最多阻塞这么久（与锁心跳同一策略）
const POLL_STEP: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    mtime_ms: u128,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
struct VaultChange {
    kind: &'static str,
    path: String,
}

/// 轮询型 watcher（不引入 notify crate）：按 mtime + size 指纹对比整库 Markdown 文件。
pub struct Watcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub fn spawn(app: AppHandle, root: PathBuf) -> Watcher {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("ember-vault-watcher".to_string())
        .spawn(move || run(app, root, flag))
        .map_err(|error| eprintln!("vault watcher 启动失败：{error}"))
        .ok();

    Watcher { stop, thread }
}

fn run(app: AppHandle, root: PathBuf, stop: Arc<AtomicBool>) {
    let mut previous = scan(&root);
    while !stop.load(Ordering::Relaxed) {
        // 切片等待：Drop 需要 join 本线程，整段 sleep 会让退出最多阻塞一个轮询周期
        let mut remaining = POLL_INTERVAL;
        while remaining > Duration::ZERO && !stop.load(Ordering::Relaxed) {
            let step = remaining.min(POLL_STEP);
            thread::sleep(step);
            remaining -= step;
        }
        if stop.load(Ordering::Relaxed) {
            break;
        }

        let current = scan(&root);
        for (path, fingerprint) in &current {
            match previous.get(path) {
                None => emit(&app, "created", path),
                Some(known) if known != fingerprint => emit(&app, "changed", path),
                Some(_) => {}
            }
        }
        for path in previous.keys() {
            if !current.contains_key(path) {
                emit(&app, "removed", path);
            }
        }
        previous = current;
    }
}

fn emit(app: &AppHandle, kind: &'static str, path: &str) {
    if let Err(error) = app.emit(
        "vault://changed",
        VaultChange {
            kind,
            path: path.to_string(),
        },
    ) {
        eprintln!("vault://changed 事件发送失败：{error}");
    }
}

fn scan(root: &Path) -> HashMap<String, Fingerprint> {
    let mut files = HashMap::new();
    collect(root, root, &mut files);
    files
}

fn collect(root: &Path, dir: &Path, out: &mut HashMap<String, Fingerprint>) {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::WORKBENCH_DIR || name.starts_with('.') {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect(root, &entry.path(), out);
            continue;
        }
        if !file_type.is_file() || !name.ends_with(".md") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let absolute = entry.path();
        let Ok(relative) = absolute.strip_prefix(root) else {
            continue;
        };
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or_else(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis())
                    .unwrap_or_default()
            });
        out.insert(
            relative.to_string_lossy().replace('\\', "/"),
            Fingerprint {
                mtime_ms,
                size: metadata.len(),
            },
        );
    }
}
