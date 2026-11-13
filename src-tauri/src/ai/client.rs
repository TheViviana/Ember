use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode};

use super::config::{AiProviderConfig, ChatRequest, ProviderKind};
use super::dns::{validate_resolved, DnsResolver, SystemResolver};
use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult};
use super::sse::{StreamEvent, StreamParser};

const USER_AGENT: &str = "Ember/0.1";

/// 取消标志的轮询间隔：读停滞时取消指令最多延迟这个时长生效
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy)]
pub struct TransportLimits {
    pub connect: Duration,
    pub read: Duration,
    pub total: Duration,
    pub max_bytes: usize,
}

impl Default for TransportLimits {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            read: Duration::from_secs(90),
            total: Duration::from_secs(600),
            max_bytes: 8 * 1024 * 1024,
        }
    }
}

pub struct ChatGateway<R: DnsResolver> {
    resolver: R,
    limits: TransportLimits,
}

impl ChatGateway<SystemResolver> {
    pub fn new() -> Self {
        Self {
            resolver: SystemResolver,
            limits: TransportLimits::default(),
        }
    }
}

impl Default for ChatGateway<SystemResolver> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: DnsResolver> ChatGateway<R> {
    pub fn with_parts(resolver: R, limits: TransportLimits) -> Self {
        Self { resolver, limits }
    }

    /// 聊天入口：未配置时在创建任何客户端、解析任何域名之前直接返回。
    pub async fn chat<F>(
        &self,
        config: Option<&AiProviderConfig>,
        api_key: Option<&str>,
        request: &ChatRequest,
        cancel: &AtomicBool,
        mut on_event: F,
    ) -> AiResult<()>
    where
        F: FnMut(StreamEvent),
    {
        if cancel.load(Ordering::Relaxed) {
            return Err(AiError::Cancelled);
        }
        let config = config.ok_or(AiError::NotConfigured)?;
        if config.model.trim().is_empty() {
            return Err(AiError::NotConfigured);
        }
        let endpoint = AiEndpoint::parse(&config.base_url, config.allow_insecure_http)?;
        if config.provider == ProviderKind::OpenAiCompatible
            && api_key.map(str::trim).unwrap_or_default().is_empty()
        {
            return Err(AiError::KeyMissing);
        }
        let client = self.build_client(&endpoint)?;
        let path = match config.provider {
            ProviderKind::Ollama => "api/chat",
            ProviderKind::OpenAiCompatible => "chat/completions",
        };
        let url = endpoint.request_url(path)?;
        let body = request_body(config, request);
        let mut builder = client.post(url).json(&body);
        if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
            builder = builder.bearer_auth(key);
        }
        let response = builder.send().await.map_err(map_request_error)?;
        let status = response.status();
        if !status.is_success() {
            // Ollama 对「模型不支持对话」（例如 embedding 模型）返回 400，
            // 请求体由本层固定生成，因此这里可以判定为模型不可用而不是网络故障
            return Err(if status == StatusCode::BAD_REQUEST && config.provider == ProviderKind::Ollama {
                AiError::ModelUnavailable
            } else {
                map_status(status)
            });
        }
        let mut response = response;
        let mut parser = StreamParser::new(config.provider);
        let mut received = 0usize;
        loop {
            // 取消标志与下一个数据块竞速：读停滞时取消也能即时生效，
            // 不必等 read_timeout（90s）超时才观察到标志位
            let next = tokio::select! {
                chunk = response.chunk() => chunk,
                _ = tokio::time::sleep(CANCEL_POLL_INTERVAL) => {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(AiError::Cancelled);
                    }
                    continue;
                }
            };
            match next {
                Ok(Some(bytes)) => {
                    if cancel.load(Ordering::Relaxed) {
                        return Err(AiError::Cancelled);
                    }
                    received += bytes.len();
                    if received > self.limits.max_bytes {
                        return Err(AiError::ResponseTooLarge);
                    }
                    for event in parser.feed(&bytes)? {
                        on_event(event);
                    }
                }
                Ok(None) => break,
                Err(error) => return Err(map_request_error(error)),
            }
        }
        for event in parser.finish()? {
            on_event(event);
        }
        if !parser.is_done() {
            on_event(StreamEvent::Done);
        }
        Ok(())
    }

    /// 列出本机 Ollama 已下载的模型：端点固定为 api/tags，云端提供方一律拒绝。
    /// 只接受 provider 基址 + 固定路径，不开放任意 URL / method。
    pub async fn list_models(&self, config: &AiProviderConfig) -> AiResult<Vec<String>> {
        if config.provider != ProviderKind::Ollama {
            return Err(AiError::UnsupportedProvider);
        }
        let endpoint = AiEndpoint::parse(&config.base_url, config.allow_insecure_http)?;
        let client = self.build_client(&endpoint)?;
        let url = endpoint.request_url("api/tags")?;
        let response = client
            .get(url)
            .timeout(Duration::from_secs(8))
            .send()
            .await
            .map_err(map_request_error)?;
        let status = response.status();
        if !status.is_success() {
            // 这里 404 通常意味着基址不是 Ollama 服务，而不是模型缺失
            return Err(if status == StatusCode::NOT_FOUND {
                AiError::InvalidResponse
            } else {
                map_status(status)
            });
        }
        // 流式累计并逐块限额：先整包缓冲再查大小会让异常端点撑爆内存（与 chat 同一防护）
        let mut response = response;
        let mut received = 0usize;
        let mut buffer: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(bytes)) => {
                    received += bytes.len();
                    if received > self.limits.max_bytes {
                        return Err(AiError::ResponseTooLarge);
                    }
                    buffer.extend_from_slice(&bytes);
                }
                Ok(None) => break,
                Err(error) => return Err(map_request_error(error)),
            }
        }
        parse_model_names(&buffer)
    }

    fn build_client(&self, endpoint: &AiEndpoint) -> AiResult<Client> {
        let mut builder = Client::builder()
            .connect_timeout(self.limits.connect)
            .read_timeout(self.limits.read)
            .timeout(self.limits.total)
            .redirect(Policy::none())
            .no_proxy()
            .user_agent(USER_AGENT);
        if !endpoint.is_ip_host() {
            let host = endpoint.host();
            let addresses = self.resolver.resolve(host, endpoint.port()?)?;
            validate_resolved(&addresses)?;
            builder = builder.resolve_to_addrs(host, &addresses);
        }
        builder.build().map_err(|_| AiError::Network)
    }
}

fn request_body(config: &AiProviderConfig, request: &ChatRequest) -> serde_json::Value {
    match config.provider {
        ProviderKind::OpenAiCompatible => serde_json::json!({
            "model": config.model,
            "messages": request.messages,
            "stream": true,
            "temperature": config.temperature,
            "max_tokens": config.max_output_tokens,
        }),
        ProviderKind::Ollama => serde_json::json!({
            "model": config.model,
            "messages": request.messages,
            "stream": true,
            "options": {
                "temperature": config.temperature,
                "num_predict": config.max_output_tokens,
            },
        }),
    }
}

fn map_status(status: StatusCode) -> AiError {
    match status.as_u16() {
        401 | 403 => AiError::Unauthorized,
        404 => AiError::ModelUnavailable,
        408 | 504 => AiError::Timeout,
        429 => AiError::RateLimited,
        _ => AiError::Network,
    }
}

#[derive(serde::Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagEntry>,
}

#[derive(serde::Deserialize)]
struct TagEntry {
    name: String,
}

/// 解析 ollama api/tags：只取模型名，去空、去重、排序，便于下拉稳定展示
fn parse_model_names(bytes: &[u8]) -> AiResult<Vec<String>> {
    let parsed: TagsResponse =
        serde_json::from_slice(bytes).map_err(|_| AiError::InvalidResponse)?;
    let mut names: Vec<String> = parsed
        .models
        .into_iter()
        .map(|entry| entry.name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

fn map_request_error(error: reqwest::Error) -> AiError {
    // 连接超时与读超时要分开：连接都没建立时，前端不能宣称「已连上」
    if error.is_timeout() && error.is_connect() {
        return AiError::ConnectTimeout;
    }
    if error.is_timeout() {
        AiError::Timeout
    } else {
        AiError::Network
    }
}

#[cfg(test)]
mod tests {
    use std::io::{ErrorKind, Read, Write};
    use std::net::{Shutdown, SocketAddr, TcpListener};
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};
    use std::thread;

    use super::*;
    use crate::ai::config::{ChatMessage, ChatRole};

    const RESPONSE_HEAD: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";

    struct FixedResolver {
        addresses: Vec<SocketAddr>,
    }

    impl DnsResolver for FixedResolver {
        fn resolve(&self, _host: &str, _port: u16) -> AiResult<Vec<SocketAddr>> {
            Ok(self.addresses.clone())
        }
    }

    struct MockServer {
        port: u16,
        connections: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
    }

    impl MockServer {
        fn spawn(payloads: Vec<String>, delay: Duration) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("绑定 mock 服务");
            let port = listener.local_addr().expect("读取端口").port();
            listener.set_nonblocking(true).expect("设置非阻塞");
            let connections = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let counter = Arc::clone(&connections);
            let flag = Arc::clone(&stop);
            thread::spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            counter.fetch_add(1, Ordering::SeqCst);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let mut request = [0u8; 4096];
                            let _ = stream.read(&mut request);
                            for (index, payload) in payloads.iter().enumerate() {
                                if index > 0 {
                                    thread::sleep(delay);
                                }
                                if stream.write_all(payload.as_bytes()).is_err() {
                                    break;
                                }
                                let _ = stream.flush();
                            }
                            // 半关闭写端并等待对端读完，避免 macOS 上的 RST 丢弃已写数据
                            let _ = stream.shutdown(Shutdown::Write);
                            let _ = stream.set_read_timeout(Some(Duration::from_millis(200)));
                            let mut sink = [0u8; 64];
                            while let Ok(read) = stream.read(&mut sink) {
                                if read == 0 {
                                    break;
                                }
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                port,
                connections,
                stop,
            }
        }

        fn loopback_base(&self, path: &str) -> String {
            format!("{}://{}:{}{}", "http", "127.0.0.1", self.port, path)
        }

        fn host_base(&self, host: &str, path: &str) -> String {
            format!("{}://{}:{}{}", "http", host, self.port, path)
        }

        fn connections(&self) -> usize {
            self.connections.load(Ordering::SeqCst)
        }
    }

    impl Drop for MockServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    fn request() -> ChatRequest {
        ChatRequest {
            messages: vec![ChatMessage {
                role: ChatRole::User,
                content: "你好".to_string(),
            }],
        }
    }

    fn config(base_url: String) -> AiProviderConfig {
        AiProviderConfig {
            provider: ProviderKind::OpenAiCompatible,
            base_url,
            model: "demo".to_string(),
            temperature: 0.2,
            max_output_tokens: 64,
            allow_insecure_http: true,
        }
    }

    fn gateway(resolver: FixedResolver, limits: TransportLimits) -> ChatGateway<FixedResolver> {
        ChatGateway::with_parts(resolver, limits)
    }

    /// AI client 测试共享 tauri 的全局 tokio runtime，且多个用例依赖紧时序
    /// （50ms 读超时、5ms 分片间隔）与 mock 服务器线程竞速——并行满载下 CPU
    /// 饥饿会让它们偶发超时。串行化本模块的用例：每个用例不足 1s，总开销可忽略。
    static AI_TEST_GATE: Mutex<()> = Mutex::new(());

    fn ai_test_gate() -> std::sync::MutexGuard<'static, ()> {
        AI_TEST_GATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[test]
    fn no_connection_when_provider_missing() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(vec![RESPONSE_HEAD.to_string()], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            None,
            None,
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::NotConfigured)));
        thread::sleep(Duration::from_millis(80));
        println!("未配置 provider：mock 连接数 = {}", server.connections());
        assert_eq!(server.connections(), 0);
    }

    #[test]
    fn streams_from_pinned_loopback_address() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(
            vec![
                RESPONSE_HEAD.to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n".to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            Duration::from_millis(5),
        );
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let config = config(server.host_base("pinned.test", "/v1"));
        let cancel = AtomicBool::new(false);
        let mut text = String::new();
        let mut done = false;
        tauri::async_runtime::block_on(gateway.chat(
            Some(&config),
            Some("sk-demo"),
            &request(),
            &cancel,
            |event| match event {
                StreamEvent::Text(chunk) => text.push_str(&chunk),
                StreamEvent::Done => done = true,
            },
        ))
        .expect("流式请求");
        assert_eq!(text, "你好");
        assert!(done);
        assert_eq!(server.connections(), 1);
    }

    #[test]
    fn cancels_after_first_delta() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(
            vec![
                RESPONSE_HEAD.to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"首\"}}]}\n\n".to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"尾\"}}]}\n\n".to_string(),
            ],
            Duration::from_millis(300),
        );
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let config = config(server.loopback_base("/v1"));
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&config),
            Some("sk-demo"),
            &request(),
            &cancel,
            |event| {
                if matches!(event, StreamEvent::Text(_)) {
                    cancel.store(true, Ordering::SeqCst);
                }
            },
        ));
        assert!(
            matches!(result, Err(AiError::Cancelled)),
            "取消后应返回 Cancelled，实际：{result:?}"
        );
    }

    #[test]
    fn rejects_rebinding_to_link_local_before_connecting() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(vec![RESPONSE_HEAD.to_string()], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![
                SocketAddr::from(([127, 0, 0, 1], server.port)),
                SocketAddr::from(([169, 254, 169, 254], server.port)),
            ],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let config = config(server.host_base("rebind.test", "/v1"));
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&config),
            Some("sk-demo"),
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::InvalidEndpoint(_))));
        thread::sleep(Duration::from_millis(80));
        println!("DNS 重绑定到 link-local：mock 连接数 = {}", server.connections());
        assert_eq!(server.connections(), 0);
    }

    #[test]
    fn rejects_stream_over_byte_limit() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(
            vec![
                RESPONSE_HEAD.to_string(),
                "data: {\"choices\":[{\"delta\":{\"content\":\"超限\"}}]}\n\n".to_string(),
            ],
            Duration::ZERO,
        );
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let limits = TransportLimits {
            max_bytes: 16,
            ..TransportLimits::default()
        };
        let gateway = gateway(resolver, limits);
        let config = config(server.loopback_base("/v1"));
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&config),
            Some("sk-demo"),
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::ResponseTooLarge)));
    }

    #[test]
    fn lists_models_from_fixed_tags_endpoint() {
        let _gate = ai_test_gate();
        let body = r#"{"models":[{"name":"qwen2.5:7b"},{"name":"llama3.2:3b"},{"name":"qwen2.5:7b"},{"name":"  "}]}"#;
        let payload = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let server = MockServer::spawn(vec![payload], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let mut ollama = config(server.loopback_base(""));
        ollama.provider = ProviderKind::Ollama;
        ollama.model = String::new();
        let names = tauri::async_runtime::block_on(gateway.list_models(&ollama)).expect("列模型");
        assert_eq!(
            names,
            vec!["llama3.2:3b".to_string(), "qwen2.5:7b".to_string()]
        );
    }

    #[test]
    fn refuses_model_list_for_cloud_provider() {
        let _gate = ai_test_gate();
        let server = MockServer::spawn(vec![RESPONSE_HEAD.to_string()], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let cloud = config(server.loopback_base("/v1"));
        let result = tauri::async_runtime::block_on(gateway.list_models(&cloud));
        assert!(matches!(result, Err(AiError::UnsupportedProvider)));
        thread::sleep(Duration::from_millis(80));
        assert_eq!(server.connections(), 0);
    }

    #[test]
    fn marks_missing_model_as_unavailable() {
        let _gate = ai_test_gate();
        let payload = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 44\r\nConnection: close\r\n\r\n{\"error\":\"model 'demo' not found\"}        ";
        let server = MockServer::spawn(vec![payload.to_string()], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let mut ollama = config(server.loopback_base(""));
        ollama.provider = ProviderKind::Ollama;
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&ollama),
            None,
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::ModelUnavailable)));
    }

    #[test]
    fn marks_ollama_chat_rejection_as_model_unavailable() {
        let _gate = ai_test_gate();
        let body = r#"{"error":"\"bge-m3:latest\" does not support chat"}"#;
        let payload = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let server = MockServer::spawn(vec![payload], Duration::ZERO);
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let gateway = gateway(resolver, TransportLimits::default());
        let mut ollama = config(server.loopback_base(""));
        ollama.provider = ProviderKind::Ollama;
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&ollama),
            None,
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::ModelUnavailable)));
    }

    #[test]
    fn times_out_when_stream_goes_silent() {
        let _gate = ai_test_gate();
        // mock 间隔 1s：给 50ms 读超时留足 20 倍裕量，DONE 不会抢在超时前到达
        let server = MockServer::spawn(
            vec![
                RESPONSE_HEAD.to_string(),
                "data: [DONE]\n\n".to_string(),
            ],
            Duration::from_millis(1000),
        );
        let resolver = FixedResolver {
            addresses: vec![SocketAddr::from(([127, 0, 0, 1], server.port))],
        };
        let limits = TransportLimits {
            read: Duration::from_millis(50),
            ..TransportLimits::default()
        };
        let gateway = gateway(resolver, limits);
        let config = config(server.loopback_base("/v1"));
        let cancel = AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(gateway.chat(
            Some(&config),
            Some("sk-demo"),
            &request(),
            &cancel,
            |_| {},
        ));
        assert!(matches!(result, Err(AiError::Timeout)));
    }
}
