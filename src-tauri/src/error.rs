/// 面向 IPC 的错误：序列化成 `{ code, message }`，前端据此映射到 EmberError 的 code。
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("路径越界：{0}")]
    PathOutside(String),
    #[error("库为只读模式，写操作被拒绝")]
    Readonly,
    #[error("文件不存在：{0}")]
    NotFound(String),
    #[error("库尚未初始化")]
    Uninitialized,
    #[error("载荷编码非法：{0}")]
    Encoding(String),
    #[error("IO 错误：{0}")]
    Io(#[from] std::io::Error),
    /// 带绝对磁盘路径的 IO 错误：用户需要知道文件究竟在哪
    #[error("IO 错误（{path}）：{message}")]
    IoAt { path: String, message: String },
    #[error("序列化错误：{0}")]
    Serde(#[from] serde_json::Error),
}

impl VaultError {
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::PathOutside(_) => "path_outside_vault",
            VaultError::Readonly => "vault_locked",
            VaultError::NotFound(_) => "doc_not_found",
            VaultError::Uninitialized => "vault_uninitialized",
            VaultError::Encoding(_) => "invalid_payload",
            VaultError::Io(_) => "io_failed",
            VaultError::IoAt { .. } => "io_failed",
            VaultError::Serde(_) => "invalid_payload",
        }
    }
}

impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("VaultError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type VaultResult<T> = Result<T, VaultError>;
