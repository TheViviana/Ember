//! 公共免费翻译接口：MyMemory 主通道、Google gtx 回落。
//!
//! 只有用户在设置里显式选择「公共免费接口」并点击翻译时才会走到这里；
//! 端点固定为下面两个 https 域名，复用 AI 层已有的安全姿势：
//! 只允许 https、阻断内网/链路本地/元数据地址、DNS 解析后逐 IP 校验并钉死、
//! 禁止跟随重定向。这里不提供任何通用 HTTP 命令。

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::client::{build_client_with, TransportLimits};
use super::dns::SystemResolver;
use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult};

const MYMEMORY_ORIGIN: &str = "https://api.mymemory.translated.net";
const GOOGLE_ORIGIN: &str = "https://translate.googleapis.com";

/// 免费接口单次约 500 字节上限；与 Deep-Notes 一样按 450 字符切块
const MAX_CHUNK_CHARS: usize = 450;
/// 太短的片段（标签、单词）不送翻译
const MIN_LENGTH: usize = 8;
/// 中文占比达到 30% 就当作已是中文
const CJK_RATIO_PERCENT: usize = 30;
/// 单请求超时：免费接口偶发挂起，不能让整段翻译一直卡在进行中
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 同一通道失败后退避重试一次
const RETRY_DELAY: Duration = Duration::from_millis(600);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// 进程内 LRU：只缓存完整成功的结果
const CACHE_CAPACITY: usize = 300;

/// 单段翻译结果：`failed` 是该段内失败并被保留原文的分块数。
#[derive(Debug, Clone, Serialize)]
pub struct PublicTranslation {
    pub text: String,
    pub failed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicEndpoint {
    MyMemory,
    Google,
}

/// 可注入的取数层：生产实现走 reqwest，测试用假实现验证重试与回落。
trait PublicFetcher: Sync {
    fn fetch<'a>(
        &'a self,
        endpoint: PublicEndpoint,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = AiResult<String>> + Send + 'a>>;
}

struct HttpFetcher {
    mymemory: reqwest::Client,
    google: reqwest::Client,
}

impl HttpFetcher {
    fn new() -> AiResult<Self> {
        let limits = TransportLimits {
            connect: Duration::from_secs(5),
            read: REQUEST_TIMEOUT,
            total: REQUEST_TIMEOUT,
            ..TransportLimits::default()
        };
        let mymemory = AiEndpoint::parse(MYMEMORY_ORIGIN, false)?;
        let google = AiEndpoint::parse(GOOGLE_ORIGIN, false)?;
        Ok(Self {
            mymemory: build_client_with(&SystemResolver, &mymemory, limits)?,
            google: build_client_with(&SystemResolver, &google, limits)?,
        })
    }
}

impl PublicFetcher for HttpFetcher {
    fn fetch<'a>(
        &'a self,
        endpoint: PublicEndpoint,
        text: &'a str,
    ) -> Pin<Box<dyn Future<Output = AiResult<String>> + Send + 'a>> {
        Box::pin(async move {
            let (client, url) = match endpoint {
                PublicEndpoint::MyMemory => (&self.mymemory, mymemory_url(text)?),
                PublicEndpoint::Google => (&self.google, google_url(text)?),
            };
            let response = client
                .get(url)
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await
                .map_err(map_request_error)?;
            let status = response.status();
            if !status.is_success() {
                return Err(map_status(status));
            }
            let bytes = response.bytes().await.map_err(map_request_error)?;
            if bytes.len() > MAX_RESPONSE_BYTES {
                return Err(AiError::ResponseTooLarge);
            }
            let body = std::str::from_utf8(&bytes).map_err(|_| AiError::InvalidResponse)?;
            match endpoint {
                PublicEndpoint::MyMemory => parse_mymemory(body),
                PublicEndpoint::Google => parse_google(body),
            }
        })
    }
}

enum ChunkOutcome {
    Translated(String),
    /// 中文占比过高或太短：不发送，原样保留
    Skipped,
    /// 主通道与回落通道都失败：保留原文并计数
    Failed,
}

/// 整段入口：命中缓存直接返回；只有全部可译分块成功才写缓存。
pub async fn translate_block(text: &str, cancel: &AtomicBool) -> AiResult<PublicTranslation> {
    let source = text.trim();
    if source.is_empty() {
        return Ok(PublicTranslation {
            text: String::new(),
            failed: 0,
        });
    }
    if let Some(hit) = cache_lookup(source) {
        return Ok(PublicTranslation {
            text: hit,
            failed: 0,
        });
    }
    let fetcher = HttpFetcher::new()?;
    translate_block_with(&fetcher, source, cancel, RETRY_DELAY, cache()).await
}

async fn translate_block_with(
    fetcher: &dyn PublicFetcher,
    text: &str,
    cancel: &AtomicBool,
    retry_delay: Duration,
    cache: &Mutex<LruCache>,
) -> AiResult<PublicTranslation> {
    let source = text.trim();
    if source.is_empty() {
        return Ok(PublicTranslation {
            text: String::new(),
            failed: 0,
        });
    }
    if let Some(hit) = cache
        .lock()
        .ok()
        .and_then(|mut entries| entries.get(source))
    {
        return Ok(PublicTranslation {
            text: hit,
            failed: 0,
        });
    }

    let parts = chunk_text(source);
    let mut outputs: Vec<String> = Vec::with_capacity(parts.len());
    let mut failed = 0u32;
    let mut index = 0usize;
    while index < parts.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(AiError::Cancelled);
        }
        let first = &parts[index];
        if let Some(second) = parts.get(index + 1) {
            // 2 路并发：每对分块同时发出，失败各自回落
            let (left, right) = tokio::join!(
                translate_chunk(fetcher, first, cancel, retry_delay),
                translate_chunk(fetcher, second, cancel, retry_delay)
            );
            let left = left?;
            let right = right?;
            if matches!(left, ChunkOutcome::Failed) {
                failed += 1;
            }
            outputs.push(outcome_text(left, first));
            if matches!(right, ChunkOutcome::Failed) {
                failed += 1;
            }
            outputs.push(outcome_text(right, second));
            index += 2;
        } else {
            let only = translate_chunk(fetcher, first, cancel, retry_delay).await?;
            if matches!(only, ChunkOutcome::Failed) {
                failed += 1;
            }
            outputs.push(outcome_text(only, first));
            index += 1;
        }
    }

    let translated = outputs.concat();
    if failed == 0 {
        if let Ok(mut entries) = cache.lock() {
            entries.set(source.to_string(), translated.clone());
        }
    }
    Ok(PublicTranslation {
        text: translated,
        failed,
    })
}

fn outcome_text(outcome: ChunkOutcome, original: &str) -> String {
    match outcome {
        ChunkOutcome::Translated(text) => text,
        ChunkOutcome::Skipped | ChunkOutcome::Failed => original.to_string(),
    }
}

async fn translate_chunk(
    fetcher: &dyn PublicFetcher,
    text: &str,
    cancel: &AtomicBool,
    retry_delay: Duration,
) -> AiResult<ChunkOutcome> {
    if !is_translatable_chunk(text) {
        return Ok(ChunkOutcome::Skipped);
    }
    // 主通道先重试一次，再走回落通道；两个通道都失败就保留原文。
    // 不跨到本地模型：通道选择由用户显式决定。
    for endpoint in [PublicEndpoint::MyMemory, PublicEndpoint::Google] {
        for attempt in 0..2 {
            if cancel.load(Ordering::Relaxed) {
                return Err(AiError::Cancelled);
            }
            match fetcher.fetch(endpoint, text).await {
                Ok(value) => return Ok(ChunkOutcome::Translated(value)),
                Err(AiError::Cancelled) => return Err(AiError::Cancelled),
                Err(_) => {
                    if attempt == 0 {
                        tokio::time::sleep(retry_delay).await;
                    }
                }
            }
        }
    }
    Ok(ChunkOutcome::Failed)
}

fn mymemory_url(text: &str) -> AiResult<reqwest::Url> {
    let endpoint = AiEndpoint::parse(MYMEMORY_ORIGIN, false)?;
    let mut url = endpoint.base_url().clone();
    url.set_path("/get");
    url.query_pairs_mut()
        .append_pair("q", text)
        .append_pair("langpair", "en|zh-CN");
    Ok(url)
}

fn google_url(text: &str) -> AiResult<reqwest::Url> {
    let endpoint = AiEndpoint::parse(GOOGLE_ORIGIN, false)?;
    let mut url = endpoint.base_url().clone();
    url.set_path("/translate_a/single");
    url.query_pairs_mut()
        .append_pair("client", "gtx")
        .append_pair("sl", "auto")
        .append_pair("tl", "zh-CN")
        .append_pair("dt", "t")
        .append_pair("q", text);
    Ok(url)
}

#[derive(Debug, Deserialize)]
struct MyMemoryResponseData {
    #[serde(rename = "translatedText", default)]
    translated_text: String,
}

#[derive(Debug, Deserialize)]
struct MyMemoryResponse {
    #[serde(rename = "responseData", default)]
    response_data: Option<MyMemoryResponseData>,
}

fn parse_mymemory(body: &str) -> AiResult<String> {
    let parsed: MyMemoryResponse =
        serde_json::from_str(body).map_err(|_| AiError::InvalidResponse)?;
    let text = parsed
        .response_data
        .map(|data| data.translated_text.trim().to_string())
        .unwrap_or_default();
    // 配额用尽时接口会把警告文本塞进 translatedText，按失败处理而不是展示给用户
    if text.is_empty() || text.to_ascii_uppercase().contains("MYMEMORY WARNING") {
        return Err(AiError::InvalidResponse);
    }
    Ok(text)
}

fn parse_google(body: &str) -> AiResult<String> {
    let parsed: serde_json::Value =
        serde_json::from_str(body).map_err(|_| AiError::InvalidResponse)?;
    let segments = parsed
        .get(0)
        .and_then(|value| value.as_array())
        .ok_or(AiError::InvalidResponse)?;
    let mut output = String::new();
    for segment in segments {
        if let Some(text) = segment.get(0).and_then(|value| value.as_str()) {
            output.push_str(text);
        }
    }
    let output = output.trim().to_string();
    if output.is_empty() {
        return Err(AiError::InvalidResponse);
    }
    Ok(output)
}

/// 按 `.!?;。！？；` 句界切块；单个超长句子保持原样（与 Deep-Notes 一致）。
fn chunk_text(text: &str) -> Vec<String> {
    if text.chars().count() <= MAX_CHUNK_CHARS {
        return vec![text.to_string()];
    }
    let mut parts = Vec::new();
    let mut buffer = String::new();
    let mut buffer_len = 0usize;
    for segment in split_sentences(text) {
        let segment_len = segment.chars().count();
        if buffer_len > 0 && buffer_len + segment_len > MAX_CHUNK_CHARS {
            parts.push(std::mem::take(&mut buffer));
            buffer_len = 0;
        }
        buffer.push_str(segment);
        buffer_len += segment_len;
    }
    if !buffer.is_empty() {
        parts.push(buffer);
    }
    parts
}

fn split_sentences(text: &str) -> Vec<&str> {
    let mut sentences = Vec::new();
    let mut start = 0usize;
    for (index, ch) in text.char_indices() {
        if matches!(ch, '.' | '!' | '?' | ';' | '。' | '！' | '？' | '；') {
            let end = index + ch.len_utf8();
            sentences.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    sentences
}

fn is_translatable_chunk(text: &str) -> bool {
    let compact: String = text.chars().filter(|ch| !ch.is_whitespace()).collect();
    let length = compact.chars().count();
    if length < MIN_LENGTH {
        return false;
    }
    let cjk = compact
        .chars()
        .filter(|ch| matches!(ch, '\u{4e00}'..='\u{9fff}'))
        .count();
    cjk * 100 < length * CJK_RATIO_PERCENT
}

fn map_status(status: reqwest::StatusCode) -> AiError {
    match status.as_u16() {
        408 | 504 => AiError::Timeout,
        429 => AiError::RateLimited,
        _ => AiError::Network,
    }
}

fn map_request_error(error: reqwest::Error) -> AiError {
    if error.is_timeout() && error.is_connect() {
        return AiError::ConnectTimeout;
    }
    if error.is_timeout() {
        AiError::Timeout
    } else {
        AiError::Network
    }
}

/// 进程内 LRU：命中刷新顺序，超限淘汰最旧。
struct LruCache {
    capacity: usize,
    order: VecDeque<String>,
    entries: HashMap<String, String>,
}

impl LruCache {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::new(),
            entries: HashMap::new(),
        }
    }

    fn get(&mut self, key: &str) -> Option<String> {
        let value = self.entries.get(key)?.clone();
        self.touch(key);
        Some(value)
    }

    fn set(&mut self, key: String, value: String) {
        if self.entries.insert(key.clone(), value).is_some() {
            self.touch(&key);
        } else {
            self.order.push_back(key);
        }
        while self.order.len() > self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(position) = self.order.iter().position(|item| item == key) {
            self.order.remove(position);
        }
        self.order.push_back(key.to_string());
    }
}

static CACHE: OnceLock<Mutex<LruCache>> = OnceLock::new();

fn cache() -> &'static Mutex<LruCache> {
    CACHE.get_or_init(|| Mutex::new(LruCache::new(CACHE_CAPACITY)))
}

fn cache_lookup(key: &str) -> Option<String> {
    cache().lock().ok().and_then(|mut entries| entries.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFetcher {
        calls: Mutex<Vec<PublicEndpoint>>,
        mymemory: Mutex<VecDeque<Option<String>>>,
        google: Mutex<VecDeque<Option<String>>>,
    }

    impl FakeFetcher {
        fn new(mymemory: Vec<Option<&str>>, google: Vec<Option<&str>>) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                mymemory: Mutex::new(
                    mymemory
                        .into_iter()
                        .map(|item| item.map(str::to_string))
                        .collect(),
                ),
                google: Mutex::new(
                    google
                        .into_iter()
                        .map(|item| item.map(str::to_string))
                        .collect(),
                ),
            }
        }

        fn calls(&self) -> Vec<PublicEndpoint> {
            self.calls.lock().expect("读取调用记录").clone()
        }
    }

    impl PublicFetcher for FakeFetcher {
        fn fetch<'a>(
            &'a self,
            endpoint: PublicEndpoint,
            _text: &'a str,
        ) -> Pin<Box<dyn Future<Output = AiResult<String>> + Send + 'a>> {
            Box::pin(async move {
                self.calls.lock().expect("记录调用").push(endpoint);
                let queue = match endpoint {
                    PublicEndpoint::MyMemory => &self.mymemory,
                    PublicEndpoint::Google => &self.google,
                };
                let next = queue.lock().expect("读取假响应").pop_front().flatten();
                match next {
                    Some(text) => Ok(text),
                    None => Err(AiError::Network),
                }
            })
        }
    }

    fn run<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn splits_at_sentence_boundaries_and_respects_the_cap() {
        let sentence = "This is a sentence. ";
        let text = sentence.repeat(40);
        assert!(text.chars().count() > MAX_CHUNK_CHARS);
        let parts = chunk_text(&text);
        assert!(parts.len() > 1);
        assert!(parts
            .iter()
            .all(|part| part.chars().count() <= MAX_CHUNK_CHARS));
        assert_eq!(parts.concat(), text);
    }

    #[test]
    fn skips_short_and_already_chinese_chunks() {
        assert!(!is_translatable_chunk("hello"));
        assert!(is_translatable_chunk("A short English sentence."));
        assert!(!is_translatable_chunk("这是一段已经足够长的中文正文内容"));
        assert!(is_translatable_chunk(
            "This paragraph mixes 中文 with English words."
        ));
    }

    #[test]
    fn builds_https_urls_with_encoded_query() {
        let mymemory = mymemory_url("Hello & 世界").expect("MyMemory 地址");
        assert_eq!(mymemory.scheme(), "https");
        assert_eq!(mymemory.host_str(), Some("api.mymemory.translated.net"));
        assert_eq!(mymemory.path(), "/get");
        assert!(!mymemory.as_str().contains(' '));
        let pairs: HashMap<String, String> = mymemory.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("q").map(String::as_str), Some("Hello & 世界"));
        assert_eq!(pairs.get("langpair").map(String::as_str), Some("en|zh-CN"));

        let google = google_url("Hello").expect("Google 地址");
        assert_eq!(google.scheme(), "https");
        assert_eq!(google.host_str(), Some("translate.googleapis.com"));
        assert_eq!(google.path(), "/translate_a/single");
        let pairs: HashMap<String, String> = google.query_pairs().into_owned().collect();
        assert_eq!(pairs.get("client").map(String::as_str), Some("gtx"));
        assert_eq!(pairs.get("sl").map(String::as_str), Some("auto"));
        assert_eq!(pairs.get("tl").map(String::as_str), Some("zh-CN"));
        assert_eq!(pairs.get("dt").map(String::as_str), Some("t"));
    }

    #[test]
    fn parses_mymemory_and_rejects_quota_warning() {
        let ok = parse_mymemory(r#"{"responseData":{"translatedText":"你好"}}"#);
        assert_eq!(ok.expect("正常响应"), "你好");
        let warning = parse_mymemory(
            r#"{"responseData":{"translatedText":"MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY"}}"#,
        );
        assert!(warning.is_err());
        assert!(parse_mymemory(r#"{"responseData":{}}"#).is_err());
    }

    #[test]
    fn parses_google_segments() {
        // gtx 的真实结构：首元素是「分段数组」，每段再取 [0] 作为译文
        let body = r#"[[["你好","Hello",null,null,1],["世界","world",null,null,1]],null,"en"]"#;
        assert_eq!(parse_google(body).expect("正常响应"), "你好世界");
        assert!(parse_google("[]").is_err());
    }

    #[test]
    fn retries_once_then_falls_back_to_google() {
        let fetcher = FakeFetcher::new(vec![None, None], vec![Some("译文")]);
        let cancel = AtomicBool::new(false);
        let cache = Mutex::new(LruCache::new(CACHE_CAPACITY));
        let result = run(translate_block_with(
            &fetcher,
            "A short English sentence.",
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("翻译");
        assert_eq!(result.text, "译文");
        assert_eq!(result.failed, 0);
        assert_eq!(
            fetcher.calls(),
            vec![
                PublicEndpoint::MyMemory,
                PublicEndpoint::MyMemory,
                PublicEndpoint::Google
            ]
        );
    }

    #[test]
    fn keeps_original_when_both_channels_fail() {
        let fetcher = FakeFetcher::new(vec![None, None], vec![None, None]);
        let cancel = AtomicBool::new(false);
        let cache = Mutex::new(LruCache::new(CACHE_CAPACITY));
        let source = "A short English sentence.";
        let result = run(translate_block_with(
            &fetcher,
            source,
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("翻译");
        assert_eq!(result.text, source);
        assert_eq!(result.failed, 1);
        assert!(cache.lock().expect("缓存").get(source).is_none());
    }

    #[test]
    fn skips_chunks_without_network_calls() {
        let fetcher = FakeFetcher::new(Vec::new(), Vec::new());
        let cancel = AtomicBool::new(false);
        let cache = Mutex::new(LruCache::new(CACHE_CAPACITY));
        let source = "这是一段已经足够长的中文正文内容";
        let result = run(translate_block_with(
            &fetcher,
            source,
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("翻译");
        assert_eq!(result.text, source);
        assert_eq!(result.failed, 0);
        assert!(fetcher.calls().is_empty());
    }

    #[test]
    fn caches_only_after_every_chunk_succeeds() {
        let cancel = AtomicBool::new(false);
        let cache = Mutex::new(LruCache::new(CACHE_CAPACITY));
        let source = "A short English sentence.";

        let failing = FakeFetcher::new(vec![None, None], vec![None, None]);
        let result = run(translate_block_with(
            &failing,
            source,
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("首次翻译");
        assert_eq!(result.failed, 1);
        assert!(cache.lock().expect("缓存").get(source).is_none());

        let ok = FakeFetcher::new(vec![Some("译文")], Vec::new());
        let result = run(translate_block_with(
            &ok,
            source,
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("成功翻译");
        assert_eq!(result.text, "译文");
        assert_eq!(
            cache.lock().expect("缓存").get(source).as_deref(),
            Some("译文")
        );

        let unused = FakeFetcher::new(Vec::new(), Vec::new());
        let result = run(translate_block_with(
            &unused,
            source,
            &cancel,
            Duration::ZERO,
            &cache,
        ))
        .expect("缓存命中");
        assert_eq!(result.text, "译文");
        assert!(unused.calls().is_empty());
    }

    #[test]
    fn stops_between_chunks_when_cancelled() {
        let fetcher = FakeFetcher::new(vec![Some("译文")], Vec::new());
        let cancel = AtomicBool::new(true);
        let cache = Mutex::new(LruCache::new(CACHE_CAPACITY));
        let result = run(translate_block_with(
            &fetcher,
            "A short English sentence.",
            &cancel,
            Duration::ZERO,
            &cache,
        ));
        assert!(matches!(result, Err(AiError::Cancelled)));
        assert!(fetcher.calls().is_empty());
    }

    #[test]
    fn lru_evicts_the_oldest_entry() {
        let mut cache = LruCache::new(2);
        cache.set("a".to_string(), "1".to_string());
        cache.set("b".to_string(), "2".to_string());
        assert_eq!(cache.get("a").as_deref(), Some("1"));
        cache.set("c".to_string(), "3".to_string());
        assert!(cache.get("b").is_none());
        assert_eq!(cache.get("a").as_deref(), Some("1"));
        assert_eq!(cache.get("c").as_deref(), Some("3"));
        assert_eq!(cache.entries.len(), 2);
    }

    /// 真实网络验证，默认跳过：`cargo test ai::public_translate::tests::real_public_translation -- --ignored --nocapture`
    #[test]
    #[ignore = "真实网络：手动验证公共接口"]
    fn real_public_translation() {
        let cancel = AtomicBool::new(false);
        let result = run(translate_block(
            "Ember keeps every note as a plain Markdown file on disk.",
            &cancel,
        ))
        .expect("公共接口翻译");
        assert!(
            result
                .text
                .chars()
                .any(|ch| matches!(ch, '\u{4e00}'..='\u{9fff}')),
            "译文应包含中文：{}",
            result.text
        );
        assert_eq!(result.failed, 0, "分块失败数");
        println!("公共接口译文：{}", result.text);
    }
}
