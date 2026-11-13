use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::ai::client::{ChatGateway, TransportLimits};
use crate::ai::config::{AiProviderConfig, ChatMessage, ChatRequest, ChatRole, ProviderKind};
use crate::ai::dns::SystemResolver;
use crate::ai::endpoint::AiEndpoint;
use crate::ai::error::{AiError, AiResult};
use crate::ai::keychain::{KeyOrigin, KeyStore, MacKeychain};
use crate::ai::sse::StreamEvent;

/// 进程内钥匙串/内存会话；不跨命令暴露任何明文读取入口。
pub struct AiState {
    keys: KeyStore<MacKeychain>,
    /// requestId → 取消标志；流结束即移除
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AiState {
    pub fn new() -> Self {
        Self {
            keys: KeyStore::new(MacKeychain),
            cancels: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for AiState {
    fn default() -> Self {
        Self::new()
    }
}

/// 前端传来的 AI 配置：只含定位与模型，密钥单独传递。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigInput {
    provider: ProviderKind,
    base_url: String,
    model: String,
}

impl AiConfigInput {
    fn provider_config(&self) -> AiProviderConfig {
        AiProviderConfig {
            provider: self.provider,
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            temperature: 0.3,
            max_output_tokens: 2048,
            allow_insecure_http: false,
        }
    }

    /// 账户名 = `provider:v1:<origin>`，与端点绑定，换地址不会串用旧密钥。
    fn account(&self) -> AiResult<String> {
        let endpoint = AiEndpoint::parse(&self.base_url, false)?;
        Ok(endpoint.account(self.provider.as_str()))
    }
}

#[derive(Debug, Serialize)]
pub struct AiTestResult {
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

/// 保存密钥：优先系统钥匙串；钥匙串不可用时降级为进程内存（8 小时 TTL），返回值告知实际落点。
#[tauri::command]
pub fn ai_key_save(
    state: State<'_, AiState>,
    config: AiConfigInput,
    key: String,
) -> AiResult<String> {
    let secret = key.trim();
    if secret.is_empty() {
        return Err(AiError::KeyMissing);
    }
    let account = config.account()?;
    let origin = state.keys.write(&account, secret)?;
    Ok(match origin {
        KeyOrigin::Keychain => "keychain",
        KeyOrigin::Memory => "memory",
    }
    .to_string())
}

/// 只回报是否存在，永不返回密钥原文。
#[tauri::command]
pub fn ai_key_status(state: State<'_, AiState>, config: AiConfigInput) -> AiResult<bool> {
    match state.keys.read(&config.account()?) {
        Ok(_) => Ok(true),
        Err(AiError::KeyMissing) => Ok(false),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub fn ai_key_delete(state: State<'_, AiState>, config: AiConfigInput) -> AiResult<()> {
    let account = config.account()?;
    match state.keys.delete(&account) {
        Ok(()) => Ok(()),
        // 钥匙串整体不可用时，可读状态只剩会话内存，而 delete 已经把它清掉——
        // 此时报「删除失败」反而会让界面停在「已保存」的假象，按成功回报。
        Err(AiError::KeychainUnavailable) if matches!(state.keys.read(&account), Err(AiError::KeychainUnavailable)) => {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// 连接测试：发一条最小请求并读完流。
/// 首次调用可能触发 Ollama 冷加载模型，读超时单独放宽到 120s；
/// 正式对话仍用 ChatGateway::new() 的默认超时，两处互不影响。
#[tauri::command]
pub async fn ai_test_connection(
    state: State<'_, AiState>,
    config: AiConfigInput,
) -> AiResult<AiTestResult> {
    let mut provider = config.provider_config();
    provider.max_output_tokens = 32;
    provider.temperature = 0.0;
    let account = config.account()?;
    let key = state.keys.read(&account).ok();
    let request = ChatRequest {
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: "请只回复 OK".to_string(),
        }],
    };
    let gateway = ChatGateway::with_parts(
        SystemResolver,
        TransportLimits {
            connect: Duration::from_secs(8),
            read: Duration::from_secs(120),
            total: Duration::from_secs(150),
            ..TransportLimits::default()
        },
    );
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    gateway
        .chat(
            Some(&provider),
            key.as_ref().map(|secret| secret.expose()),
            &request,
            &cancel,
            |_| {},
        )
        .await?;
    Ok(AiTestResult {
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 列出本机 Ollama 已下载的模型：固定端点 api/tags，云端提供方直接拒绝。
#[tauri::command]
pub async fn ai_list_models(config: AiConfigInput) -> AiResult<Vec<String>> {
    let gateway = ChatGateway::with_parts(
        SystemResolver,
        TransportLimits {
            connect: Duration::from_secs(3),
            read: Duration::from_secs(8),
            total: Duration::from_secs(10),
            ..TransportLimits::default()
        },
    );
    gateway.list_models(&config.provider_config()).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiStreamEvent {
    Delta { text: String },
    Done,
    Error { code: String, message: String },
}

/// 面板对话入口：逐段推送到 Channel；同一 requestId 可被 `ai_chat_cancel` 中止。
#[tauri::command]
pub async fn ai_chat_stream(
    state: State<'_, AiState>,
    config: AiConfigInput,
    messages: Vec<ChatMessage>,
    request_id: String,
    on_event: Channel<AiStreamEvent>,
) -> AiResult<()> {
    let provider = config.provider_config();
    let account = config.account()?;
    // 记住取钥失败的真实原因（只读一次）：provider 要求 key 而 chat 报 KeyMissing 时，
    // 用真实原因（钥匙串被拒等）替换笼统的「缺少 API Key」
    let key = state.keys.read(&account);
    let key_failure: Option<(String, String)> = key.as_ref().err().map(|error| {
        (error.code().to_string(), error.to_string())
    });
    let key = key.ok();
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut cancels) = state.cancels.lock() {
        cancels.insert(request_id.clone(), Arc::clone(&cancel));
    }
    let gateway = ChatGateway::new();
    let request = ChatRequest { messages };
    let delta_channel = on_event.clone();
    let result = gateway
        .chat(
            Some(&provider),
            key.as_ref().map(|secret| secret.expose()),
            &request,
            &cancel,
            |event| {
                if let StreamEvent::Text(text) = event {
                    let _ = delta_channel.send(AiStreamEvent::Delta { text });
                }
            },
        )
        .await;
    if let Ok(mut cancels) = state.cancels.lock() {
        cancels.remove(&request_id);
    }
    match &result {
        Ok(()) => {
            let _ = on_event.send(AiStreamEvent::Done);
        }
        Err(AiError::Cancelled) => {}
        Err(error) => {
            // 取钥失败的真实原因优先于 chat 内部的笼统 KeyMissing
            let real = matches!(error, AiError::KeyMissing)
                .then(|| key_failure.as_ref())
                .flatten();
            let (code, message) = match real {
                Some(real) => (real.0.clone(), real.1.clone()),
                None => (error.code().to_string(), error.to_string()),
            };
            let _ = on_event.send(AiStreamEvent::Error {
                code,
                message,
            });
        }
    }
    result
}

#[tauri::command]
pub fn ai_chat_cancel(state: State<'_, AiState>, request_id: String) {
    if let Ok(cancels) = state.cancels.lock() {
        if let Some(flag) = cancels.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_binds_provider_and_origin() {
        let input = AiConfigInput {
            provider: ProviderKind::Ollama,
            base_url: format!("{}://{}:{}", "http", "127.0.0.1", 11434),
            model: "qwen".to_string(),
        };
        assert_eq!(input.account().expect("账户名"), "ollama:v1:http://127.0.0.1:11434");
    }

    #[test]
    fn provider_config_uses_defaults() {
        let input = AiConfigInput {
            provider: ProviderKind::OpenAiCompatible,
            base_url: format!("{}://{}", "https", "api.example.test"),
            model: "demo".to_string(),
        };
        let config = input.provider_config();
        assert_eq!(config.max_output_tokens, 2048);
        assert_eq!(config.temperature, 0.3);
        assert!(!config.allow_insecure_http);
    }
}
