use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::vault::{ignored_dirs, is_ignored_dir, paths};

const POLL_INTERVAL: Duration = Duration::from_millis(1200);
/// 轮询等待的切片步长：Drop join 最多阻塞这么久
const POLL_STEP: Duration = Duration::from_millis(250);
/// 连续无变化时逐级拉长轮询间隔（最多 6s），降低空闲态全库扫描开销；
/// 一旦发现变化立即恢复到 1.2s，活跃期的事件延迟不变。
const POLL_INTERVAL_MAX: Duration = Duration::from_millis(6000);
/// 单个 tick 最多逐条发送的事件数：超过即只发一条 `overflow`，
/// 由前端做一次全量对账。正常编辑远低于该值；批量导入/整库替换才可能击穿，
/// 此时逐条发送会让 IPC 与前端逐个读盘的成本随文件数线性放大。
const MAX_EVENTS_PER_TICK: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Fingerprint {
    mtime_ms: u128,
    size: u64,
}

impl Fingerprint {
    fn mtime_millis(&self) -> u64 {
        self.mtime_ms.min(u64::MAX as u128) as u64
    }
}

#[derive(Debug, Clone, Serialize)]
struct VaultChange {
    kind: &'static str,
    path: String,
    /// 仅 renamed 事件携带：原路径
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    /// 事件发生时的 mtime（Unix 毫秒）：前端据此跳过元数据未变的文件
    #[serde(skip_serializing_if = "Option::is_none")]
    mtime: Option<u64>,
    /// 事件发生时的字节数
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    /// 仅 overflow 事件携带：本 tick 被合并掉的事件数
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
}

impl VaultChange {
    fn file(
        kind: &'static str,
        path: &str,
        from: Option<&str>,
        fingerprint: Option<&Fingerprint>,
    ) -> Self {
        Self {
            kind,
            path: path.to_string(),
            from: from.map(str::to_string),
            mtime: fingerprint.map(Fingerprint::mtime_millis),
            size: fingerprint.map(|value| value.size),
            count: None,
        }
    }

    fn overflow(count: usize) -> Self {
        Self {
            kind: "overflow",
            path: String::new(),
            from: None,
            mtime: None,
            size: None,
            count: Some(count),
        }
    }
}

fn should_overflow(count: usize) -> bool {
    count > MAX_EVENTS_PER_TICK
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

/// 启动轮询线程。线程创建失败必须由调用方决定如何告知用户：
/// 静默吞掉会出现「库已打开但外部改动永不刷新」的假象。
pub fn spawn(app: AppHandle, root: PathBuf) -> Result<Watcher, std::io::Error> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let thread = thread::Builder::new()
        .name("ember-vault-watcher".to_string())
        .spawn(move || run(app, root, flag))?;

    Ok(Watcher {
        stop,
        thread: Some(thread),
    })
}

fn run(app: AppHandle, root: PathBuf, stop: Arc<AtomicBool>) {
    let mut previous = scan(&root);
    let mut interval = POLL_INTERVAL;
    while !stop.load(Ordering::Relaxed) {
        // 切片等待：Drop 需要 join 本线程，整段 sleep 会让退出最多阻塞一个轮询周期
        let mut remaining = interval;
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
                Some(known) if known != fingerprint => {
                    emit(&app, VaultChange::file("changed", path, None, Some(fingerprint)))
                }
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
        let mut changes: Vec<VaultChange> = Vec::new();
        for (from, to) in &renames {
            changes.push(VaultChange::file("renamed", to, Some(from), current.get(to)));
        }
        for path in &rest_created {
            changes.push(VaultChange::file("created", path, None, current.get(path)));
        }
        for path in &rest_removed {
            changes.push(VaultChange::file("removed", path, None, None));
        }
        // 单 tick 事件过多：只发一条溢出标记，让前端做一次全量对账，
        // 而不是把几千条逐文件事件推过 IPC。
        if should_overflow(changes.len()) {
            emit(&app, VaultChange::overflow(changes.len()));
        } else {
            for change in changes {
                emit(&app, change);
            }
        }
        // 有变化回到最高频率；空闲则退避到最长 6s
        interval = if created.is_empty() && removed.is_empty() {
            (interval * 2).min(POLL_INTERVAL_MAX)
        } else {
            POLL_INTERVAL
        };
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

fn emit(app: &AppHandle, change: VaultChange) {
    if let Err(error) = app.emit("vault://changed", change) {
        eprintln!("vault://changed 事件发送失败：{error}");
    }
}

fn scan(root: &Path) -> HashMap<String, Fingerprint> {
    let ignored = ignored_dirs(root);
    let mut files = HashMap::new();
    collect(root, root, &ignored, &mut files);
    files
}

fn collect(
    root: &Path,
    dir: &Path,
    ignored: &[String],
    out: &mut HashMap<String, Fingerprint>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == paths::WORKBENCH_DIR || name.starts_with('.') || is_ignored_dir(&name, ignored) {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect(root, &entry.path(), ignored, out);
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

    #[test]
    fn tick_below_threshold_keeps_individual_events() {
        assert!(!should_overflow(0));
        assert!(!should_overflow(MAX_EVENTS_PER_TICK));
        assert!(should_overflow(MAX_EVENTS_PER_TICK + 1));
    }

    #[test]
    fn change_payload_carries_metadata_and_rename_source() {
        let change = VaultChange::file("renamed", "notes/new.md", Some("notes/old.md"), Some(&fingerprint(1234, 99)));
        assert_eq!(change.mtime, Some(1234));
        assert_eq!(change.size, Some(99));
        assert_eq!(change.from.as_deref(), Some("notes/old.md"));
        let removed = VaultChange::file("removed", "notes/gone.md", None, None);
        assert_eq!(removed.mtime, None);
        assert_eq!(removed.size, None);
        let overflow = VaultChange::overflow(3000);
        assert_eq!(overflow.kind, "overflow");
        assert_eq!(overflow.count, Some(3000));
    }

    #[test]
    fn scan_skips_dependency_and_configured_dirs() {
        let root = temp_root();
        for (dir, file) in [
            ("notes", "a.md"),
            ("node_modules/pkg", "readme.md"),
            (".git/hooks", "sample.md"),
            ("vendor/dep", "doc.md"),
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(root.join(dir).join(file), b"x").unwrap();
        }
        fs::create_dir_all(root.join(".workbench")).unwrap();
        fs::write(
            root.join(".workbench/settings.json"),
            br#"{"watcherIgnoreDirs":["vendor"]}"#,
        )
        .unwrap();

        let files = scan(&root);
        let mut paths: Vec<String> = files.keys().cloned().collect();
        paths.sort();
        assert_eq!(paths, vec!["notes/a.md".to_string()]);

        let _ = fs::remove_dir_all(&root);
    }

    fn temp_root() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or_default();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("ember-watcher-{}-{nanos}-{seq}", std::process::id()))
    }
}
