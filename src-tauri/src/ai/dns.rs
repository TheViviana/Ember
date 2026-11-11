use std::net::{SocketAddr, ToSocketAddrs};

use super::endpoint::is_blocked_ip;
use super::error::{AiError, AiResult};

pub trait DnsResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> AiResult<Vec<SocketAddr>>;
}

pub struct SystemResolver;

impl DnsResolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> AiResult<Vec<SocketAddr>> {
        let addresses: Vec<SocketAddr> = (host, port)
            .to_socket_addrs()
            .map_err(|_| AiError::Network)?
            .collect();
        if addresses.is_empty() {
            return Err(AiError::Network);
        }
        Ok(addresses)
    }
}

/// 解析结果必须整体可用：只要任意一个地址命中受限网段就拒绝。
/// 注意：受限网段仅指 link-local / 多播 / 未指定等（见 is_blocked_ip）；
/// RFC1918 私网是**有意放行**的——局域网 Ollama（192.168.x.x 等）是支持的用法，
/// 端点本身已在 parse 时由用户显式配置并做回环/明文 HTTP 校验。
pub(crate) fn validate_resolved(addresses: &[SocketAddr]) -> AiResult<()> {
    if addresses.is_empty() {
        return Err(AiError::Network);
    }
    if addresses.iter().any(|address| is_blocked_ip(address.ip())) {
        return Err(AiError::InvalidEndpoint(
            "域名解析命中受限地址".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

    use super::*;

    #[test]
    fn rejects_empty_answer() {
        assert!(validate_resolved(&[]).is_err());
    }

    #[test]
    fn rejects_link_local_and_metadata() {
        let link_local = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)), 443);
        assert!(validate_resolved(&[link_local]).is_err());
        let v6_link_local = SocketAddr::new(
            IpAddr::V6(Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 1)),
            443,
        );
        assert!(validate_resolved(&[v6_link_local]).is_err());
    }

    #[test]
    fn rejects_ipv4_mapped_restricted_ranges() {
        let mapped = SocketAddr::new(
            IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0xa9fe, 0xa9fe)), // ::ffff:169.254.169.254
            443,
        );
        assert!(validate_resolved(&[mapped]).is_err());
        let mapped_loopback = SocketAddr::new(
            IpAddr::V6(Ipv6Addr::new(0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001)), // ::ffff:127.0.0.1
            11434,
        );
        assert!(validate_resolved(&[mapped_loopback]).is_ok(), "映射回环不属受限网段");
    }

    #[test]
    fn rejects_mixed_public_and_private() {
        let public = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)), 443);
        let link_local = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(169, 254, 169, 254)), 443);
        assert!(validate_resolved(&[public, link_local]).is_err());
    }

    #[test]
    fn accepts_loopback_and_public() {
        let loopback = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 11434);
        let public = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(93, 184, 216, 34)), 443);
        assert!(validate_resolved(&[loopback]).is_ok());
        assert!(validate_resolved(&[public]).is_ok());
    }
}
