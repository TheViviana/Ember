use std::net::IpAddr;

use reqwest::Url;

use super::error::AiError;

pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiEndpoint {
    origin: String,
    base_url: Url,
}

impl AiEndpoint {
    pub fn parse(raw: &str, allow_insecure_http: bool) -> Result<Self, AiError> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(AiError::InvalidEndpoint("地址为空".to_string()));
        }
        if text.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
            return Err(AiError::InvalidEndpoint("地址含有空白或控制字符".to_string()));
        }
        let mut url =
            Url::parse(text).map_err(|_| AiError::InvalidEndpoint("无法解析为合法 URL".to_string()))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(AiError::InvalidEndpoint("只允许 http 或 https".to_string()));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(AiError::InvalidEndpoint("地址不允许携带用户名或密码".to_string()));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(AiError::InvalidEndpoint("地址不允许携带查询串或片段".to_string()));
        }
        let host = url
            .host_str()
            .ok_or_else(|| AiError::InvalidEndpoint("缺少主机名".to_string()))?
            .to_ascii_lowercase();
        let bare_host = host.trim_start_matches('[').trim_end_matches(']');
        if is_blocked_host(bare_host) {
            return Err(AiError::InvalidEndpoint("主机地址被安全策略禁止".to_string()));
        }
        let loopback = is_loopback_host(bare_host);
        if url.scheme() == "http" && !loopback && !allow_insecure_http {
            return Err(AiError::InvalidEndpoint(
                "非回环地址必须使用 https，或显式允许明文 HTTP".to_string(),
            ));
        }
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(if path.is_empty() { "/" } else { &path });
        let origin = match url.port() {
            Some(port) => format!("{}://{}:{}", url.scheme(), host, port),
            None => format!("{}://{}", url.scheme(), host),
        };
        Ok(Self { origin, base_url: url })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    pub fn account(&self, provider: &str) -> String {
        format!("{}:v1:{}", provider, self.origin)
    }

    pub fn host(&self) -> &str {
        self.base_url.host_str().unwrap_or_default()
    }

    pub fn port(&self) -> Result<u16, AiError> {
        self.base_url
            .port_or_known_default()
            .ok_or_else(|| AiError::InvalidEndpoint("缺少可用端口".to_string()))
    }

    pub fn is_ip_host(&self) -> bool {
        self.host()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok()
    }

    pub fn request_url(&self, path: &str) -> Result<Url, AiError> {
        let joined = format!(
            "{}/{}",
            self.base_url.as_str().trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        Url::parse(&joined).map_err(|_| AiError::InvalidEndpoint("请求地址无法组装".to_string()))
    }
}

fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    host.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

pub(crate) fn is_blocked_ip(ip: IpAddr) -> bool {
    // IPv4-mapped IPv6（::ffff:a.b.c.d）先还原成 IPv4 再判断：
    // V6 自身的判定不覆盖映射形式，::ffff:169.254.169.254 会绕过元数据地址黑名单。
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    match ip {
        IpAddr::V4(ip) => {
            ip.is_unspecified() || ip.is_multicast() || ip.is_link_local() || ip.is_broadcast()
        }
        IpAddr::V6(ip) => ip.is_unspecified() || ip.is_multicast() || ip.is_unicast_link_local(),
    }
}

fn is_blocked_host(host: &str) -> bool {
    if host.is_empty() || host == "metadata.google.internal" || host == "metadata" {
        return true;
    }
    host.parse::<IpAddr>().map(is_blocked_ip).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composed(scheme: &str, rest: &str) -> String {
        format!("{}://{}", scheme, rest)
    }

    #[test]
    fn accepts_loopback_http() {
        let endpoint = AiEndpoint::parse(DEFAULT_OLLAMA_BASE_URL, false).expect("回环地址应通过");
        assert_eq!(endpoint.origin(), "http://127.0.0.1:11434");
        assert_eq!(endpoint.account("ollama"), "ollama:v1:http://127.0.0.1:11434");
    }

    #[test]
    fn accepts_ipv6_loopback_http() {
        let raw = composed("http", "[::1]:11434");
        let endpoint = AiEndpoint::parse(&raw, false).expect("IPv6 回环应通过");
        assert_eq!(endpoint.origin(), composed("http", "[::1]:11434"));
    }

    #[test]
    fn rejects_public_http_without_opt_in() {
        let raw = composed("http", "example.com/v1");
        assert!(matches!(
            AiEndpoint::parse(&raw, false),
            Err(AiError::InvalidEndpoint(_))
        ));
        assert!(AiEndpoint::parse(&raw, true).is_ok());
    }

    #[test]
    fn accepts_public_https() {
        let raw = composed("https", "example.com/v1/");
        let endpoint = AiEndpoint::parse(&raw, false).expect("公网 https 应通过");
        assert_eq!(endpoint.origin(), composed("https", "example.com"));
        assert_eq!(endpoint.base_url().path(), "/v1");
    }

    #[test]
    fn rejects_non_http_scheme() {
        let raw = composed("ftp", "example.com");
        assert!(matches!(
            AiEndpoint::parse(&raw, true),
            Err(AiError::InvalidEndpoint(_))
        ));
    }

    #[test]
    fn rejects_credentials_query_and_fragment() {
        assert!(AiEndpoint::parse(&composed("https", "user:pass@example.com"), false).is_err());
        assert!(AiEndpoint::parse(&composed("https", "example.com/v1?key=1"), false).is_err());
        assert!(AiEndpoint::parse(&composed("https", "example.com/v1#part"), false).is_err());
        assert!(AiEndpoint::parse(&composed("https", "example.com /v1"), false).is_err());
    }

    #[test]
    fn rejects_metadata_and_link_local() {
        assert!(AiEndpoint::parse(&composed("http", "169.254.169.254/latest"), true).is_err());
        assert!(AiEndpoint::parse(
            &composed("http", "metadata.google.internal/computeMetadata"),
            true
        )
        .is_err());
    }

    #[test]
    fn rejects_ipv4_mapped_metadata_variants() {
        // IPv4-mapped IPv6 与 IP 字面量路径都必须命中黑名单
        assert!(AiEndpoint::parse(&composed("http", "[::ffff:169.254.169.254]/latest"), true).is_err());
        assert!(AiEndpoint::parse(&composed("https", "[::ffff:169.254.169.254]"), false).is_err());
        // 未映射的公网 IPv6 不受影响
        assert!(AiEndpoint::parse(&composed("https", "[2606:4700::6810:85e5]"), false).is_ok());
    }
}
