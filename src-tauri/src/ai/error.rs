/// AI 层错误：只输出安全文案，不携带请求头、密钥、URL 查询串或响应正文。
#[derive(Debug, thiserror::Error)]
pub enum AiError {
    #[error("尚未配置 AI 提供方")]
    NotConfigured,
    #[error("AI 端点非法：{0}")]
    InvalidEndpoint(String),
    #[error("缺少 API Key")]
    KeyMissing,
    #[error("系统钥匙串不可用：可在系统设置里授权 Ember 访问钥匙串，或重新保存 API Key（仅本次运行有效）")]
    KeychainUnavailable,
    #[error("提供方拒绝了凭据")]
    Unauthorized,
    #[error("提供方限流")]
    RateLimited,
    #[error("请求超时")]
    Timeout,
    #[error("网络请求失败")]
    Network,
    #[error("模型不可用：可能未下载或名称不对")]
    ModelUnavailable,
    #[error("该提供方不支持获取模型列表")]
    UnsupportedProvider,
    #[error("提供方响应格式非法")]
    InvalidResponse,
    #[error("响应超出大小上限")]
    ResponseTooLarge,
    #[error("请求已取消")]
    Cancelled,
}

impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            AiError::NotConfigured => "ai_not_configured",
            AiError::InvalidEndpoint(_) => "ai_invalid_endpoint",
            AiError::KeyMissing => "ai_key_missing",
            AiError::KeychainUnavailable => "ai_keychain_denied",
            AiError::Unauthorized => "ai_unauthorized",
            AiError::RateLimited => "ai_rate_limited",
            AiError::Timeout => "ai_timeout",
            AiError::Network => "ai_network",
            AiError::ModelUnavailable => "ai_model_unavailable",
            AiError::UnsupportedProvider => "ai_unsupported_provider",
            AiError::InvalidResponse => "ai_invalid_response",
            AiError::ResponseTooLarge => "ai_response_too_large",
            AiError::Cancelled => "ai_cancelled",
        }
    }
}

impl serde::Serialize for AiError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("AiError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type AiResult<T> = Result<T, AiError>;
