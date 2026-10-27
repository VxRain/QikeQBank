//! AWS Signature V4（S3 子集）：Authorization 头签名 + 单块 payload。
//!
//! 只实现对象存储同步需要的形态：签名头固定为 `host;x-amz-content-sha256;x-amz-date`
//! （带临时凭据时追加 `x-amz-security-token`），payload 一次算完（不分块、不流式）。
//! 路径不做归一化、不二次编码（S3 语义），调用方传**已编码**的 canonical URI。
//!
//! 测试向量由 botocore 1.43.119 的 `S3SigV4Auth` 生成（AWS 官方实现），覆盖
//! PUT 带 payload / GET 空 payload / ListObjectsV2 查询串 / 路径式 endpoint / HEAD。

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// 空 payload 的 SHA-256（十六进制小写）
pub const EMPTY_PAYLOAD_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const HEX: &[u8; 16] = b"0123456789abcdef";
/// 百分号编码必须用大写十六进制（RFC 3986 / SigV4 规范）；与 SHA-256 的小写十六进制不同。
const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// SHA-256 → 小写十六进制
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let digest = h.finalize();
    let mut s = String::with_capacity(digest.len() * 2);
    for b in digest {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// RFC 3986 严格百分号编码：unreserved 仅 `A-Za-z0-9-_.~`。
/// `keep_slash=true` 时保留 `/` 作为路径分隔符（用于整条路径）。
pub fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => {
                out.push('%');
                out.push(HEX_UPPER[(b >> 4) as usize] as char);
                out.push(HEX_UPPER[(b & 0x0f) as usize] as char);
            }
        }
    }
    out
}

/// canonical query string：键/值分别严格编码后按 (key, value) 字典序排序，
/// 以 `&` 连接、`=` 分隔。无参数返回空串。
pub fn canonical_query(pairs: &[(String, String)]) -> String {
    let mut enc: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (uri_encode(k, false), uri_encode(v, false)))
        .collect();
    enc.sort();
    enc.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

#[derive(Debug, Clone)]
pub struct Credentials {
    pub access_key: String,
    pub secret_key: String,
    /// 临时凭据（STS）会话令牌；长期密钥为 None
    pub session_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignRequest<'a> {
    pub method: &'a str,
    /// Host 头（含非默认端口，如 `minio.local:9000`）
    pub host: &'a str,
    /// 已百分号编码的路径（以 `/` 开头，S3 不做归一化）
    pub canonical_uri: &'a str,
    /// 已编码、已排序的查询串（不含 `?`；无参数传 ""）
    pub canonical_query: &'a str,
    /// payload 的 SHA-256 小写十六进制；空 body 用 [`EMPTY_PAYLOAD_SHA256`]
    pub payload_sha256: &'a str,
    /// `YYYYMMDDTHHMMSSZ`
    pub amz_date: &'a str,
    pub region: &'a str,
    /// 固定 `"s3"`
    pub service: &'a str,
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

/// 派生签名密钥（AWS4 + 日期链）
fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

/// 生成 `Authorization` 头值。
pub fn authorization(req: &SignRequest<'_>, creds: &Credentials) -> String {
    let token = creds.session_token.as_deref().filter(|s| !s.is_empty());
    let (signed_headers, canonical_headers) = match token {
        Some(t) => (
            "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
            format!(
                "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\nx-amz-security-token:{}\n",
                req.host, req.payload_sha256, req.amz_date, t
            ),
        ),
        None => (
            "host;x-amz-content-sha256;x-amz-date",
            format!(
                "host:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
                req.host, req.payload_sha256, req.amz_date
            ),
        ),
    };
    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method,
        req.canonical_uri,
        req.canonical_query,
        canonical_headers,
        signed_headers,
        req.payload_sha256
    );
    let date = &req.amz_date[..8];
    let scope = format!("{date}/{}/{}/aws4_request", req.region, req.service);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        req.amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );
    let key = signing_key(&creds.secret_key, date, req.region, req.service);
    let signature = {
        let mut m =
            <HmacSha256 as Mac>::new_from_slice(&key).expect("HMAC 接受任意长度密钥");
        m.update(string_to_sign.as_bytes());
        let out = m.finalize().into_bytes();
        out.iter()
            .map(|b| {
                let mut s = String::with_capacity(2);
                s.push(HEX[(b >> 4) as usize] as char);
                s.push(HEX[(b & 0x0f) as usize] as char);
                s
            })
            .collect::<String>()
    };
    format!(
        "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        creds.access_key
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        }
    }

    fn auth(method: &str, host: &str, uri: &str, query: &str, payload: &str) -> String {
        authorization(
            &SignRequest {
                method,
                host,
                canonical_uri: uri,
                canonical_query: query,
                payload_sha256: payload,
                amz_date: "20130524T000000Z",
                region: "us-east-1",
                service: "s3",
            },
            &creds(),
        )
    }

    /// 期望签名由 botocore 1.43.119 `S3SigV4Auth` 生成，勿手改。
    #[test]
    fn aws_v4_vectors_from_botocore() {
        // 1) PUT 带 payload（虚拟主机风格）
        assert_eq!(
            auth(
                "PUT",
                "examplebucket.s3.us-east-1.amazonaws.com",
                "/qbank/log/dev-a/00000001.ndjson.gz",
                "",
                "b8647640c177f6e283a03a47004118c80e76f7491d754219963a341c4aa0de4e",
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=83188dcb2e1a0bbf7e530a1c7aeccc2c396cee8547d4ae803b7c450f5f2f947d"
        );
        // 2) GET 空 payload
        assert_eq!(
            auth(
                "GET",
                "examplebucket.s3.us-east-1.amazonaws.com",
                "/qbank/log/dev-a/00000001.ndjson.gz",
                "",
                EMPTY_PAYLOAD_SHA256,
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=3c0fa007a70de8bdbd04f19b2760099d0f3027a900a25e7104cd2a8b693d500b"
        );
        // 3) ListObjectsV2 查询串（含 %2F 编码与字典序排序）
        assert_eq!(
            auth(
                "GET",
                "examplebucket.s3.us-east-1.amazonaws.com",
                "/",
                "delimiter=%2F&list-type=2&max-keys=1000&prefix=qbank%2Flog%2F&start-after=qbank%2Flog%2Fdev-a%2F00000001.ndjson.gz",
                EMPTY_PAYLOAD_SHA256,
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=079599946e32f49022c89a06da15246df33d242219a3a01304af00b7cd2d3b95"
        );
        // 4) 路径式 endpoint + 非 ASCII 键（%E8%AE%BE%E5%A4%87A = 设备A）
        assert_eq!(
            auth(
                "PUT",
                "s3.us-east-1.amazonaws.com",
                "/examplebucket/qbank/log/%E8%AE%BE%E5%A4%87A/00000002.ndjson.gz",
                "",
                "b8647640c177f6e283a03a47004118c80e76f7491d754219963a341c4aa0de4e",
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=716fbe6d860063620526df97ffbc395b3d58f7c6a25303a31caadeef1d03e06a"
        );
        // 5) HEAD（空 payload）
        assert_eq!(
            auth(
                "HEAD",
                "examplebucket.s3.us-east-1.amazonaws.com",
                "/qbank/assets/ab/cdef.png",
                "",
                EMPTY_PAYLOAD_SHA256,
            ),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=b8eb38de859696bb6d95bb2730b89c30a1c95f121b8846a7cc28e0bfe3c3e776"
        );
    }

    #[test]
    fn session_token_is_signed() {
        let mut c = creds();
        c.session_token = Some("tok".into());
        let v = authorization(
            &SignRequest {
                method: "GET",
                host: "examplebucket.s3.us-east-1.amazonaws.com",
                canonical_uri: "/qbank/log/dev-a/00000001.ndjson.gz",
                canonical_query: "",
                payload_sha256: EMPTY_PAYLOAD_SHA256,
                amz_date: "20130524T000000Z",
                region: "us-east-1",
                service: "s3",
            },
            &c,
        );
        assert!(v.contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token"));
        // 令牌参与签名 → 签名必须与无令牌时不同
        assert!(!v.ends_with("3c0fa007a70de8bdbd04f19b2760099d0f3027a900a25e7104cd2a8b693d500b"));
    }

    #[test]
    fn canon_query_sorts_and_encodes() {
        let q = canonical_query(&[
            ("start-after".into(), "qbank/log/dev-a/1.gz".into()),
            ("list-type".into(), "2".into()),
            ("delimiter".into(), "/".into()),
            ("prefix".into(), "qbank/log/".into()),
        ]);
        assert_eq!(
            q,
            "delimiter=%2F&list-type=2&prefix=qbank%2Flog%2F&start-after=qbank%2Flog%2Fdev-a%2F1.gz"
        );
        assert_eq!(uri_encode("设备A b+c", false), "%E8%AE%BE%E5%A4%87A%20b%2Bc");
        assert_eq!(uri_encode("a/b~c.d_e-f", true), "a/b~c.d_e-f");
    }

    #[test]
    fn empty_payload_hash_is_known_constant() {
        assert_eq!(sha256_hex(b""), EMPTY_PAYLOAD_SHA256);
    }
}
