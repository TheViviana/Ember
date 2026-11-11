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
    /// 仅 renamed 事件携带：原路径
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
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
        let mut created: Vec<(String, Fingerprint)> = Vec::new();
        for (path, fingerprint) in &current {
            match previous.get(path) {
                None => created.push((path.clone(), fingerprint.clone())),
                Some(known) if known != fingerprint => emit(&app, "changed", path, None),
                Some(_) => {}
            }
        }
        let removed: Vec<(String, Fingerprint)> = previous
            .iter()
            .filter(|(path, _)| !current.contains_key(*path))
            .map(|(path, fingerprint)| (path.clone(), fingerprint.clone()))
            .collect();

        // 指纹相同的 removed+created 配对为重命名：内容未变只是路径变化。
        // 改了内容再改名会自然退化为 removed+created（安全降级，不丢事件）。
        let (renames, rest_removed, rest_created) = pair_renames(&removed, &created);
        for (from, to) in &renames {
            emit(&app, "renamed", to, Some(from));
        }
        for path in &rest_created {
            emit(&app, "created", path, None);
        }
        for path in &rest_removed {
            emit(&app, "removed", path, None);
        }
        previous = current;
    }
}

/// 同指纹的 removed+created 贪心配对；两侧先按路径排序保证结果确定。
fn pair_renames(
    removed: &[(String, Fingerprint)],
    created: &[(String, Fingerprint)],
) -> (Vec<(String, String)>, Vec<String>, Vec<String>) {
    // 按值克隆再排序：条目少（单轮 diff），避免多层引用把比较写绕
    let mut sorted_removed: Vec<(String, Fingerprint)> = removed.to_vec();
    let mut sorted_created: Vec<(String, Fingerprint)> = created.to_vec();
    sorted_removed.sort_by(|left, right| left.0.cmp(&right.0));
    sorted_created.sort_by(|left, right| left.0.cmp(&right.0));

    let mut renames = Vec::new();
    let mut used = vec![false; sorted_removed.len()];
    let mut rest_created = Vec::new();
    for (created_path, created_fp) in &sorted_created {
        let mut matched = false;
        for (index, (removed_path, removed_fp)) in sorted_removed.iter().enumerate() {
            if !used[index] && removed_fp == created_fp {
                used[index] = true;
                renames.push((removed_path.clone(), created_path.clone()));
                matched = true;
                break;
            }
        }
        if !matched {
            rest_created.push(created_path.clone());
        }
    }
    let rest_removed = sorted_removed
        .iter()
        .enumerate()
        .filter(|(index, _)| !used[*index])
        .map(|(_, (path, _))| path.clone())
        .collect();
    (renames, rest_removed, rest_created)
}

fn emit(app: &AppHandle, kind: &'static str, path: &str, from: Option<&str>) {
    if let Err(error) = app.emit(
        "vault://changed",
        VaultChange {
            kind,
            path: path.to_string(),
            from: from.map(str::to_string),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fingerprint(mtime_ms: u128, size: u64) -> Fingerprint {
        Fingerprint { mtime_ms, size }
    }

    #[test]
    fn same_fingerprint_pairs_as_rename() {
        let removed = vec![("notes/old.md".to_string(), fingerprint(1000, 42))];
        let created = vec![("notes/new.md".to_string(), fingerprint(1000, 42))];
        let (renames, rest_removed, rest_created) = pair_renames(&removed, &created);
        assert_eq!(renames, vec![("notes/old.md".to_string(), "notes/new.md".to_string())]);
        assert!(rest_removed.is_empty());
        assert!(rest_created.is_empty());
    }

    #[test]
    fn changed_content_does_not_pair() {
        // 改了内容再改名：指纹不同 → 退化为 removed+created，事件不丢
        let removed = vec![("notes/old.md".to_string(), fingerprint(1000, 42))];
        let created = vec![("notes/new.md".to_string(), fingerprint(2000, 43))];
        let (renames, rest_removed, rest_created) = pair_renames(&removed, &created);
        assert!(renames.is_empty());
        assert_eq!(rest_removed, vec!["notes/old.md".to_string()]);
        assert_eq!(rest_created, vec!["notes/new.md".to_string()]);
    }

    #[test]
    fn pairing_is_deterministic_and_first_match_wins() {
        let removed = vec![
            ("notes/a-old.md".to_string(), fingerprint(1000, 42)),
            ("notes/b-old.md".to_string(), fingerprint(1000, 42)),
        ];
        let created = vec![
            ("notes/z-new.md".to_string(), fingerprint(1000, 42)),
            ("notes/a-new.md".to_string(), fingerprint(1000, 42)),
        ];
        let (renames, rest_removed, rest_created) = pair_renames(&removed, &created);
        // 排序后配对：created 按路径序 a-new 先拿到 a-old，z-new 拿到 b-old
        assert_eq!(
            renames,
            vec![
                ("notes/a-old.md".to_string(), "notes/a-new.md".to_string()),
                ("notes/b-old.md".to_string(), "notes/z-new.md".to_string()),
            ]
        );
        assert!(rest_removed.is_empty() && rest_created.is_empty());
    }

    #[test]
    fn unrelated_changes_pass_through() {
        let removed = vec![("notes/gone.md".to_string(), fingerprint(1, 1))];
        let created = vec![("notes/fresh.md".to_string(), fingerprint(2, 2))];
        let (renames, rest_removed, rest_created) = pair_renames(&removed, &created);
        assert!(renames.is_empty());
        assert_eq!(rest_removed, vec!["notes/gone.md".to_string()]);
        assert_eq!(rest_created, vec!["notes/fresh.md".to_string()]);
    }
}
