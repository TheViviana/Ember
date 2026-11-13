/// 面向 IPC 的错误：序列化成 `{ code, message }`，前端据此映射到 EmberError 的 code。
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("路径越界：{0}")]
    PathOutside(String),
    #[error("库为只读，写操作被拒绝（原因见状态栏）")]
    Readonly,
    #[error("文件不存在：{0}")]
    NotFound(String),
    #[error("目标路径已存在：{0}")]
    PathExists(String),
    #[error("库尚未初始化")]
    Uninitialized,
    #[error("载荷编码非法：{0}")]
    Encoding(String),
    #[error("IO 错误：{0}")]
    Io(std::io::Error),
    /// 带绝对磁盘路径的 IO 错误：用户需要知道文件究竟在哪
    #[error("IO 错误（{path}）：{message}")]
    IoAt { path: String, message: String },
    /// 权限被拒（含 macOS TCC 未授权「文稿」）：必须与"空文件"区分开
    #[error("无权限访问库文件：{0}")]
    PermissionDenied(String),
    #[error("序列化错误：{0}")]
    Serde(#[from] serde_json::Error),
    /// 启动阶段无法建立可用库（身份损坏/版本不支持）：让前端启动页展示原因，而不是 panic
    #[error("启动失败：{0}")]
    Startup(String),
}

impl VaultError {
    pub fn code(&self) -> &'static str {
        match self {
            VaultError::PathOutside(_) => "path_outside_vault",
            VaultError::Readonly => "vault_locked",
            VaultError::NotFound(_) => "doc_not_found",
            VaultError::PathExists(_) => "path_exists",
            VaultError::Uninitialized => "vault_uninitialized",
            VaultError::Encoding(_) => "invalid_payload",
            VaultError::Io(_) => "io_failed",
            VaultError::IoAt { .. } => "io_failed",
            VaultError::PermissionDenied(_) => "permission_denied",
            VaultError::Serde(_) => "invalid_payload",
            VaultError::Startup(_) => "startup_failed",
        }
    }
}

impl From<std::io::Error> for VaultError {
    fn from(error: std::io::Error) -> Self {
        // macOS TCC 拒绝访问「文稿」时是 EPERM/EACCES，都归到 PermissionDenied，
        // 前端据此展示权限提示，而不是让用户以为文档被清空了。
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            VaultError::PermissionDenied(error.to_string())
        } else {
            VaultError::Io(error)
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

#[cfg(test)]
mod tests {
    use super::VaultError;

    #[test]
    fn permission_denied_keeps_its_own_code() {
        let error = VaultError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(error.code(), "permission_denied");
        assert!(matches!(error, VaultError::PermissionDenied(_)));
    }

    #[test]
    fn other_io_errors_stay_io_failed() {
        let error = VaultError::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(error.code(), "io_failed");
    }
}
