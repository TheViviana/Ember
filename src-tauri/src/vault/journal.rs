use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{VaultError, VaultResult};
use crate::vault::{atomic, clock, paths, ulid};

/// 超过该行数时压缩：只保留未结束事务，避免 journal 无限增长。
const COMPACT_THRESHOLD: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Prepared,
    Committed,
    Cleaned,
}

/// 规范 §6.2 的 NDJSON 事件；一次写入对应同一 `tx` 的三行。
#[derive(Debug, Serialize, Deserialize)]
pub struct JournalEvent {
    pub tx: String,
    pub phase: Phase,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub at: String,
}

fn append(root: &Path, event: &JournalEvent) -> VaultResult<()> {
    fs::create_dir_all(paths::journal_dir(root))?;
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths::journal_file(root))?;
    let mut line = serde_json::to_vec(event)?;
    line.push(b'\n');
    handle.write_all(&line)?;
    handle.sync_all()?;
    Ok(())
}

/// 读取全部事件。断电最可能撕裂的就是追加中的最后一行，因此对尾部撕裂做容错：
/// 未以换行结尾且解析失败的末尾行按「未完成写入」丢弃，并截断回写，
/// 避免下次追加把新行拼接在残行上（调用方 recover/compact 均持锁或写闸）。
/// 已完整落盘的行若解析失败，属于真实损坏而非撕裂，返回错误交人工处理。
fn read_events(root: &Path) -> VaultResult<Vec<JournalEvent>> {
    let bytes = match fs::read(paths::journal_file(root)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut events = Vec::new();
    let mut good_len = 0usize; // 到此偏移为止的所有行均完整可解析，即撕裂时的截断点
    let mut line_no = 0usize;
    for chunk in bytes.split_inclusive(|byte| *byte == b'\n') {
        line_no += 1;
        let terminated = chunk.ends_with(b"\n");
        let line = if terminated {
            &chunk[..chunk.len() - 1]
        } else {
            chunk
        };
        if line.is_empty() {
            if terminated {
                good_len += chunk.len();
            }
            continue;
        }
        match serde_json::from_slice::<JournalEvent>(line) {
            Ok(event) => {
                events.push(event);
                good_len += chunk.len();
            }
            // split_inclusive 只有末尾分片可能不带换行：断电撕裂的半截 JSON。
            Err(_) if !terminated => break,
            Err(error) => {
                return Err(VaultError::Encoding(format!(
                    "journal 第 {line_no} 行损坏（完整落盘仍无法解析，需人工处理）：{error}"
                )));
            }
        }
    }

    if good_len < bytes.len() {
        atomic::write_atomic(&paths::journal_file(root), &bytes[..good_len])?;
        eprintln!(
            "journal 尾部有 {} 字节未完成写入，已截断丢弃",
            bytes.len() - good_len
        );
    } else if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        // 尾行 JSON 完整但换行符尚未落盘：补齐，防止下次追加拼接损坏。
        let mut fixed = bytes.clone();
        fixed.push(b'\n');
        atomic::write_atomic(&paths::journal_file(root), &fixed)?;
    }
    Ok(events)
}

/// 写入顺序严格为：temp fsync → prepared fsync → rename → dir fsync → committed fsync → cleaned fsync。
pub fn write_with_journal(
    root: &Path,
    relative: &str,
    target: &Path,
    bytes: &[u8],
    kind: &str,
) -> VaultResult<()> {
    let temp = atomic::prepare(target, bytes)?;
    let temp_relative = temp.relative_to(root);
    let tx = ulid::generate();

    append(
        root,
        &JournalEvent {
            tx: tx.clone(),
            phase: Phase::Prepared,
            target: relative.to_string(),
            temp: temp_relative.clone(),
            kind: Some(kind.to_string()),
            at: clock::now_iso8601(),
        },
    )?;

    if let Err(error) = atomic::commit(&temp) {
        let _ = fs::remove_file(&temp.path);
        let _ = append(
            root,
            &JournalEvent {
                tx,
                phase: Phase::Cleaned,
                target: relative.to_string(),
                temp: temp_relative,
                kind: None,
                at: clock::now_iso8601(),
            },
        );
        return Err(error);
    }

    append(
        root,
        &JournalEvent {
            tx: tx.clone(),
            phase: Phase::Committed,
            target: relative.to_string(),
            temp: temp_relative.clone(),
            kind: None,
            at: clock::now_iso8601(),
        },
    )?;
    append(
        root,
        &JournalEvent {
            tx,
            phase: Phase::Cleaned,
            target: relative.to_string(),
            temp: temp_relative,
            kind: None,
            at: clock::now_iso8601(),
        },
    )?;

    compact(root)
}

/// 按 `tx` 取最后一条事件判定结局：prepared 未提交则删临时文件（目标仍是完整旧内容）；
/// committed 说明 rename 已生效，只需清理。
pub fn recover(root: &Path) -> VaultResult<usize> {
    let events = read_events(root)?;
    if events.is_empty() {
        return Ok(0);
    }

    let mut last: HashMap<String, JournalEvent> = HashMap::new();
    for event in events {
        last.insert(event.tx.clone(), event);
    }

    for event in last.values() {
        let temp = match event.temp.as_deref().and_then(|value| temp_target(root, value)) {
            Some(value) => value,
            None => {
                if event.temp.is_some() {
                    eprintln!(
                        "journal 事件的临时路径非法，跳过清理（宁留孤儿不删库外文件）：{:?}",
                        event.temp
                    );
                }
                continue;
            }
        };
        match event.phase {
            Phase::Prepared | Phase::Committed => match fs::remove_file(&temp) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            },
            Phase::Cleaned => {}
        }
    }

    // 全部事务已判定完毕，journal 可直接清空。
    atomic::write_atomic(&paths::journal_file(root), b"")?;
    Ok(last.len())
}

/// 校验 journal 事件里的临时文件路径：必须是库内相对路径（纯普通段）。
/// journal 若被外部篡改，`root.join("/etc/x")` 会整体替换根路径构成任意文件删除，
/// 因此绝对路径、`..`、反斜杠一律拒绝并跳过清理。
fn temp_target(root: &Path, temp: &str) -> Option<PathBuf> {
    use std::path::Component;

    if temp.is_empty() || temp.starts_with('/') || temp.contains('\\') {
        return None;
    }
    let mut path = root.to_path_buf();
    for component in Path::new(temp).components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(path)
}

fn compact(root: &Path) -> VaultResult<()> {
    let events = read_events(root)?;
    if events.len() <= COMPACT_THRESHOLD {
        return Ok(());
    }

    let mut last: HashMap<String, Phase> = HashMap::new();
    for event in &events {
        last.insert(event.tx.clone(), event.phase);
    }

    let mut kept = String::new();
    for event in &events {
        if last.get(&event.tx) == Some(&Phase::Cleaned) {
            continue;
        }
        kept.push_str(&serde_json::to_string(event)?);
        kept.push('\n');
    }
    atomic::write_atomic(&paths::journal_file(root), kept.as_bytes())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    /// 并行测试的临时目录名不能只靠纳秒时间戳：macOS 时钟粒度内可能重名。
    static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TempVault {
        root: PathBuf,
    }

    impl TempVault {
        fn new() -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "ember-journal-{}-{nanos}-{seq}",
                std::process::id()
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn journal_bytes(&self) -> Vec<u8> {
            fs::read(paths::journal_file(&self.root)).unwrap()
        }

        fn write_journal(&self, bytes: &[u8]) {
            fs::create_dir_all(paths::journal_dir(&self.root)).unwrap();
            atomic::write_atomic(&paths::journal_file(&self.root), bytes).unwrap();
        }

        /// 以 journal 事件同款字段序列化一行（含换行）。
        fn line(tx: &str, phase: Phase, temp: Option<&str>) -> Vec<u8> {
            let mut line = serde_json::to_vec(&JournalEvent {
                tx: tx.to_string(),
                phase,
                target: "notes/a.md".to_string(),
                temp: temp.map(str::to_string),
                kind: None,
                at: "2026-01-01T00:00:00Z".to_string(),
            })
            .unwrap();
            line.push(b'\n');
            line
        }
    }

    impl Drop for TempVault {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn torn_tail_is_dropped_and_truncated() {
        let vault = TempVault::new();
        let mut bytes = TempVault::line("tx1", Phase::Cleaned, Some(".workbench/.t1"));
        bytes.extend_from_slice(b"{\"tx\":\"tx2\",\"pha"); // 断电撕裂的半截 JSON
        vault.write_journal(&bytes);

        let events = read_events(&vault.root).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].tx, "tx1");
        // 文件被截断回最后一个完整行，后续追加不会拼接在残行上。
        assert_eq!(
            vault.journal_bytes(),
            TempVault::line("tx1", Phase::Cleaned, Some(".workbench/.t1"))
        );
    }

    #[test]
    fn torn_only_journal_recovers_to_empty() {
        let vault = TempVault::new();
        vault.write_journal(b"{\"tx\":\"01J");

        let events = read_events(&vault.root).unwrap();

        assert!(events.is_empty());
        assert!(vault.journal_bytes().is_empty());
    }

    #[test]
    fn complete_valid_tail_without_newline_is_repaired() {
        let vault = TempVault::new();
        let mut line = TempVault::line("tx1", Phase::Prepared, Some(".workbench/.t1"));
        line.pop(); // 去掉换行：fsync 断电时换行符恰好未落盘
        vault.write_journal(&line);

        let events = read_events(&vault.root).unwrap();

        assert_eq!(events.len(), 1);
        assert!(vault.journal_bytes().ends_with(b"\n"));
    }

    #[test]
    fn corrupt_complete_line_is_reported_not_swallowed() {
        let vault = TempVault::new();
        let mut bytes = TempVault::line("tx1", Phase::Cleaned, None);
        bytes.extend_from_slice(b"garbage-not-json\n");
        vault.write_journal(&bytes);

        let error = read_events(&vault.root).unwrap_err();

        assert!(matches!(error, VaultError::Encoding(_)));
        assert!(error.to_string().contains("第 2 行"));
    }

    #[test]
    fn recover_clears_journal_and_removes_leaked_temps() {
        let vault = TempVault::new();
        let temp = vault.root.join(".workbench").join(".t-prepared");
        fs::create_dir_all(temp.parent().unwrap()).unwrap();
        fs::write(&temp, b"partial").unwrap();
        let mut bytes = TempVault::line("tx1", Phase::Prepared, None);
        bytes.extend(TempVault::line(
            "tx2",
            Phase::Prepared,
            Some(".workbench/.t-prepared"),
        ));
        vault.write_journal(&bytes);
        // 末尾再拼一段撕裂写入，模拟崩溃现场。
        let mut torn = fs::OpenOptions::new()
            .append(true)
            .open(paths::journal_file(&vault.root))
            .unwrap();
        torn.write_all(b"{\"tx\":\"tx3").unwrap();
        drop(torn);

        let recovered = recover(&vault.root).unwrap();

        assert_eq!(recovered, 2);
        assert!(!temp.exists(), "prepared 事务的临时文件应被清理");
        assert!(vault.journal_bytes().is_empty(), "恢复完毕 journal 应清空");
    }

    #[test]
    fn write_with_journal_round_trips_and_recovers_clean() {
        let vault = TempVault::new();
        let target = vault.root.join("notes").join("a.md");
        write_with_journal(&vault.root, "notes/a.md", &target, b"hello", "user").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"hello");

        assert_eq!(recover(&vault.root).unwrap(), 1);
        assert!(vault.journal_bytes().is_empty());
        assert_eq!(fs::read(&target).unwrap(), b"hello");
    }

    #[test]
    fn recover_never_deletes_outside_paths_from_forged_events() {
        let vault = TempVault::new();
        // 被篡改的 journal：temp 是绝对路径 → root.join 整体替换根路径，构成任意文件删除。
        let evil = std::env::temp_dir().join(format!("ember-evil-{}.md", std::process::id()));
        fs::write(&evil, b"victim").unwrap();
        let mut bytes = TempVault::line("tx1", Phase::Prepared, Some(evil.to_string_lossy().as_ref()));
        // 相对路径但带 `..` 的变体同样要被拒。
        bytes.extend(TempVault::line("tx2", Phase::Prepared, Some("../ember-evil-2.md")));
        vault.write_journal(&bytes);

        let recovered = recover(&vault.root).unwrap();

        assert_eq!(recovered, 2, "非法 temp 的事件仍参与判定，只是跳过删除");
        assert!(evil.exists(), "库外文件不得被 journal 驱动的清理删除");
        fs::remove_file(&evil).unwrap();
    }
}
