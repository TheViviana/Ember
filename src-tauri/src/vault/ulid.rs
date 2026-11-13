use std::fs::File;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::vault::clock;

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

static FALLBACK_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 生成 26 字符 ULID（Crockford Base32）。不引入额外 crate：48 位毫秒时间戳 + 80 位随机数。
pub fn generate() -> String {
    generate_at(clock::now_ms())
}

fn generate_at(millis: u64) -> String {
    let mut bytes = [0u8; 16];
    bytes[0..6].copy_from_slice(&millis.to_be_bytes()[2..8]);
    bytes[6..16].copy_from_slice(&random_bytes());
    encode(&bytes)
}

/// 规范要求库身份是 26 字符 ULID；这里只校验字符集与长度，不做时间戳解析。
pub fn is_ulid(value: &str) -> bool {
    value.len() == 26 && value.bytes().all(|byte| ALPHABET.contains(&byte))
}

fn random_bytes() -> [u8; 10] {
    let mut buffer = [0u8; 10];
    // 首选 /dev/urandom；不可用走 getrandom（macOS 为 getentropy 系统调用，
    // 修复原「时间戳+计数器」回退的跨进程碰撞隐患）；两者都失败才退化为
    // 时间戳+计数器（仅剩同进程内不重复保证，记入日志便于排查）。
    if File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut buffer))
        .is_ok()
    {
        return buffer;
    }
    if getrandom::fill(&mut buffer).is_ok() {
        return buffer;
    }
    let counter = FALLBACK_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = clock::now_ms() as u128 * 1_000_000 + counter as u128;
    buffer.copy_from_slice(&nanos.to_be_bytes()[6..16]);
    eprintln!("ULID 熵源不可用，退化使用时间戳+计数器（跨进程可能碰撞）");
    buffer
}


fn encode(bytes: &[u8; 16]) -> String {
    let value = u128::from_be_bytes(*bytes);
    let mut output = [ALPHABET[0]; 26];
    for (index, slot) in output.iter_mut().enumerate() {
        let shift = 5 * (25 - index);
        *slot = ALPHABET[((value >> shift) & 0x1f) as usize];
    }
    output.iter().map(|byte| *byte as char).collect()
}
#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn generated_ids_are_unique_and_valid() {
        let ids: HashSet<String> = (0..10_000).map(|_| generate()).collect();
        assert_eq!(ids.len(), 10_000, "连续 1 万次生成不得重复");
        assert!(ids.iter().all(|id| is_ulid(id)));
    }
}
