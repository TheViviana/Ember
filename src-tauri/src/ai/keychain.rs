use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::error::{AiError, AiResult};

pub const SERVICE_V1: &str = "app.ember.desktop.ai.v1";
pub const SESSION_TTL: Duration = Duration::from_secs(8 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyOrigin {
    Keychain,
    Memory,
}

pub struct ResolvedSecret {
    value: String,
    origin: KeyOrigin,
}

// 手写 Debug：密钥结构体任何一处 {:?}/dbg!/panic 输出都不落明文
impl std::fmt::Debug for ResolvedSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedSecret")
            .field("value", &"[REDACTED]")
            .field("origin", &self.origin)
            .finish()
    }
}

impl ResolvedSecret {
    pub fn expose(&self) -> &str {
        self.value.as_str()
    }

    pub fn origin(&self) -> KeyOrigin {
        self.origin
    }
}

pub trait SecretBackend: Send + Sync {
    fn read(&self, account: &str) -> AiResult<Option<String>>;
    fn write(&self, account: &str, secret: &str) -> AiResult<()>;
    fn delete(&self, account: &str) -> AiResult<()>;
}

pub struct MacKeychain;

impl SecretBackend for MacKeychain {
    fn read(&self, account: &str) -> AiResult<Option<String>> {
        let entry =
            keyring::Entry::new(SERVICE_V1, account).map_err(|_| AiError::KeychainUnavailable)?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(AiError::KeychainUnavailable),
        }
    }

    fn write(&self, account: &str, secret: &str) -> AiResult<()> {
        let entry =
            keyring::Entry::new(SERVICE_V1, account).map_err(|_| AiError::KeychainUnavailable)?;
        entry.set_password(secret).map_err(|_| AiError::KeychainUnavailable)
    }

    fn delete(&self, account: &str) -> AiResult<()> {
        let entry =
            keyring::Entry::new(SERVICE_V1, account).map_err(|_| AiError::KeychainUnavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(AiError::KeychainUnavailable),
        }
    }
}

struct SessionKey {
    account: String,
    secret: String,
    created: Instant,
}

pub struct KeyStore<B: SecretBackend> {
    backend: B,
    session_ttl: Duration,
    session: Mutex<Option<SessionKey>>,
}

impl<B: SecretBackend> KeyStore<B> {
    pub fn new(backend: B) -> Self {
        Self::with_ttl(backend, SESSION_TTL)
    }

    pub fn with_ttl(backend: B, session_ttl: Duration) -> Self {
        Self {
            backend,
            session_ttl,
            session: Mutex::new(None),
        }
    }

    pub fn read(&self, account: &str) -> AiResult<ResolvedSecret> {
        // 钥匙串失败不阻断会话回退（ai-panel.md 的降级设计），但记住原因：
        // 会话也没有时，把真实原因（钥匙串被拒/不可用）而不是「缺少 API Key」抛给界面
        let keychain_failed = match self.backend.read(account) {
            Ok(Some(secret)) => {
                return Ok(ResolvedSecret {
                    value: secret,
                    origin: KeyOrigin::Keychain,
                })
            }
            Ok(None) => false,
            Err(AiError::KeychainUnavailable) => true,
            Err(error) => return Err(error),
        };
        let mut guard = self.session.lock().map_err(|_| AiError::KeychainUnavailable)?;
        let usable = guard
            .as_ref()
            .map(|item| item.account == account && item.created.elapsed() < self.session_ttl)
            .unwrap_or(false);
        if !usable {
            *guard = None;
            return Err(if keychain_failed {
                AiError::KeychainUnavailable
            } else {
                AiError::KeyMissing
            });
        }
        let item = guard.as_ref().ok_or(AiError::KeyMissing)?;
        Ok(ResolvedSecret {
            value: item.secret.clone(),
            origin: KeyOrigin::Memory,
        })
    }

    pub fn write(&self, account: &str, secret: &str) -> AiResult<KeyOrigin> {
        match self.backend.write(account, secret) {
            Ok(()) => {
                let mut guard = self.session.lock().map_err(|_| AiError::KeychainUnavailable)?;
                *guard = None;
                Ok(KeyOrigin::Keychain)
            }
            Err(AiError::KeychainUnavailable) => {
                let mut guard = self.session.lock().map_err(|_| AiError::KeychainUnavailable)?;
                *guard = Some(SessionKey {
                    account: account.to_string(),
                    secret: secret.to_string(),
                    created: Instant::now(),
                });
                Ok(KeyOrigin::Memory)
            }
            Err(error) => Err(error),
        }
    }

    pub fn delete(&self, account: &str) -> AiResult<()> {
        let result = self.backend.delete(account);
        let mut guard = self.session.lock().map_err(|_| AiError::KeychainUnavailable)?;
        *guard = None;
        result
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MockBackend {
        stored: Mutex<Option<String>>,
        fail_writes: Mutex<bool>,
        deletes: Mutex<u32>,
    }

    impl SecretBackend for MockBackend {
        fn read(&self, _account: &str) -> AiResult<Option<String>> {
            Ok(self.stored.lock().expect("mock 锁").clone())
        }

        fn write(&self, _account: &str, secret: &str) -> AiResult<()> {
            if *self.fail_writes.lock().expect("mock 锁") {
                return Err(AiError::KeychainUnavailable);
            }
            *self.stored.lock().expect("mock 锁") = Some(secret.to_string());
            Ok(())
        }

        fn delete(&self, _account: &str) -> AiResult<()> {
            *self.deletes.lock().expect("mock 锁") += 1;
            *self.stored.lock().expect("mock 锁") = None;
            Ok(())
        }
    }

    fn account() -> &'static str {
        "ollama:v1:http://127.0.0.1:11434"
    }

    #[test]
    fn writes_and_reads_from_keychain() {
        let store = KeyStore::new(MockBackend::default());
        assert_eq!(store.write(account(), "sk-demo").expect("写入"), KeyOrigin::Keychain);
        let secret = store.read(account()).expect("读取");
        assert_eq!(secret.expose(), "sk-demo");
        assert_eq!(secret.origin(), KeyOrigin::Keychain);
    }

    #[test]
    fn falls_back_to_memory_when_keychain_write_fails() {
        let backend = MockBackend::default();
        *backend.fail_writes.lock().expect("mock 锁") = true;
        let store = KeyStore::new(backend);
        assert_eq!(store.write(account(), "sk-demo").expect("写入"), KeyOrigin::Memory);
        let secret = store.read(account()).expect("读取");
        assert_eq!(secret.expose(), "sk-demo");
        assert_eq!(secret.origin(), KeyOrigin::Memory);
    }

    #[test]
    fn session_key_expires_after_ttl() {
        let backend = MockBackend::default();
        *backend.fail_writes.lock().expect("mock 锁") = true;
        let store = KeyStore::with_ttl(backend, Duration::from_millis(5));
        store.write(account(), "sk-demo").expect("写入");
        std::thread::sleep(Duration::from_millis(20));
        assert!(matches!(store.read(account()), Err(AiError::KeyMissing)));
    }

    #[test]
    fn session_key_is_bound_to_one_account() {
        let backend = MockBackend::default();
        *backend.fail_writes.lock().expect("mock 锁") = true;
        let store = KeyStore::new(backend);
        store.write(account(), "sk-demo").expect("写入");
        assert!(matches!(
            store.read("openai:v1:http://127.0.0.1:9999"),
            Err(AiError::KeyMissing)
        ));
    }

    #[test]
    fn delete_and_lock_clear_session() {
        let backend = MockBackend::default();
        *backend.fail_writes.lock().expect("mock 锁") = true;
        let store = KeyStore::new(backend);
        store.write(account(), "sk-demo").expect("写入");
        store.delete(account()).expect("删除");
        assert!(matches!(store.read(account()), Err(AiError::KeyMissing)));

        store.write(account(), "sk-demo").expect("再次写入");
    }

    #[test]
    fn debug_output_never_contains_secret_value() {
        let secret = ResolvedSecret {
            value: "sk-super-secret-value".to_string(),
            origin: KeyOrigin::Memory,
        };
        let rendered = format!("{secret:?}");
        assert!(rendered.contains("[REDACTED]"), "应输出脱敏占位：{rendered}");
        assert!(!rendered.contains("sk-super-secret-value"), "不得泄露明文：{rendered}");
    }
}
