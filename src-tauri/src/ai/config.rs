use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderKind {
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Ollama => "ollama",
            ProviderKind::OpenAiCompatible => "openai-compatible",
        }
    }
}

fn default_temperature() -> f32 {
    0.3
}

fn default_max_output_tokens() -> u32 {
    2048
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiProviderConfig {
    pub provider: ProviderKind,
    pub base_url: String,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_output_tokens")]
    pub max_output_tokens: u32,
    #[serde(default)]
    pub allow_insecure_http: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_names_are_stable() {
        assert_eq!(ProviderKind::Ollama.as_str(), "ollama");
        assert_eq!(ProviderKind::OpenAiCompatible.as_str(), "openai-compatible");
        let parsed: ProviderKind = serde_json::from_str("\"openai-compatible\"").expect("反序列化");
        assert_eq!(parsed, ProviderKind::OpenAiCompatible);
    }

    #[test]
    fn config_defaults_fill_optional_fields() {
        let raw = serde_json::json!({
            "provider": "ollama",
            "base_url": format!("{}://{}:{}", "http", "127.0.0.1", 11434),
            "model": "qwen",
        })
        .to_string();
        let config: AiProviderConfig = serde_json::from_str(&raw).expect("反序列化");
        assert_eq!(config.temperature, 0.3);
        assert_eq!(config.max_output_tokens, 2048);
        assert!(!config.allow_insecure_http);
    }
}
