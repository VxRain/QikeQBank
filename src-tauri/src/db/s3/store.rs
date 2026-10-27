//! 对象存储适配层：`ObjectStore` 抽象 + S3 实现 + 内存实现（测试用）。
//!
//! 抽象的目的不是"支持多云"，而是让同步编排能在无网络条件下被完整单测：
//! 所有业务逻辑只依赖 trait，S3 只剩签名与 HTTP 语义。
//!
//! 只实现对象存储同步需要的最小子集：Put / Get / Head / List / Delete。
//! 不实现分块上传（同步对象上限几 MB）、不实现多段拷贝、不实现 ACL。

use super::sign::{self, Credentials};
use chrono::Utc;
#[cfg(test)]
use std::collections::BTreeMap;

/// 当前 S3 通道的 key 布局版本。布局变更时递增，旧对象按版本前缀隔离。
pub const LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone)]
pub struct S3Config {
    /// 桶域名或自建端点：`https://s3.us-east-1.amazonaws.com` / `https://minio.local:9000`
    /// / `https://<account>.r2.cloudflarestorage.com`（可省略 `https://`，默认补 https）
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    /// 根前缀（可空）：所有对象落在 `<prefix>/v1/...`
    pub prefix: String,
    /// 路径风格：自建端点 / IP / 带端口端点必须为 true
    pub path_style: bool,
}

impl S3Config {
    /// 归一化前缀：去首尾 `/`，空串表根
    pub fn norm_prefix(&self) -> String {
        self.prefix.trim().trim_matches('/').to_string()
    }

    /// 相对 key → 含前缀与布局版本的完整 key
    pub fn full_key(&self, rel: &str) -> String {
        let rel = rel.trim_start_matches('/');
        let p = self.norm_prefix();
        if p.is_empty() {
            format!("v{LAYOUT_VERSION}/{rel}")
        } else {
            format!("{p}/v{LAYOUT_VERSION}/{rel}")
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct ListResult {
    /// 键（完整 key，含前缀）
    pub keys: Vec<String>,
    /// delimiter 为 `/` 时的子前缀（完整 key 前缀，以 `/` 结尾）
    pub common_prefixes: Vec<String>,
    pub truncated: bool,
}

impl ListResult {
    fn sort_dedup(&mut self) {
        self.keys.sort();
        self.keys.dedup();
        self.common_prefixes.sort();
        self.common_prefixes.dedup();
    }
}

#[derive(Debug, Clone)]
pub struct Object {
    pub body: Vec<u8>,
    /// 对象 Content-Type（资产下载靠它恢复 mime，无需先查本地登记表）
    pub content_type: Option<String>,
}

pub trait ObjectStore {
    fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String>;
    /// 不存在返回 `Ok(None)`（404 不是错误）
    fn get(&self, key: &str) -> Result<Option<Object>, String>;
    fn head(&self, key: &str) -> Result<bool, String>;
    fn list(
        &self,
        prefix: &str,
        start_after: Option<&str>,
        delimiter: Option<&str>,
    ) -> Result<ListResult, String>;
    /// 前缀下字典序最小的对象（只取 1 个，不拉整页）：用于判断链头是否被截断。
    fn first_key(&self, prefix: &str) -> Result<Option<String>, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
    /// 诊断用：脱敏的端点描述（不含密钥）
    fn describe(&self) -> String;
}

// ---------------------------------------------------------------------------
// S3 实现
// ---------------------------------------------------------------------------

pub struct S3Store {
    cfg: S3Config,
    creds: Credentials,
    scheme: String,
    authority: String,
    agent: ureq::Agent,
}

impl S3Store {
    pub fn new(cfg: S3Config, creds: Credentials) -> Result<Self, String> {
        if cfg.bucket.trim().is_empty() {
            return Err("S3 bucket 不能为空".into());
        }
        if cfg.region.trim().is_empty() {
            return Err("S3 region 不能为空（AWS 通常 us-east-1，自建端点填任意值）".into());
        }
        let (scheme, authority) = split_endpoint(&cfg.endpoint)?;
        if !cfg.path_style && authority.contains(':') {
            return Err(format!(
                "虚拟主机风格不支持带端口的端点 `{authority}`，请改用路径风格（path-style）"
            ));
        }
        // 关键：ureq 的 TLS provider 默认是 Rustls，**不会**因为启用了 native-tls 就自动切换。
        // 不显式指定时，任何 https 请求都会 panic（"provider is Rustls but feature is not enabled"），
        // 而该 panic 会顺着 Tauri 命令线程把整个进程 abort 掉（0xc0000409）。
        // 根证书用系统证书库（Windows = Schannel 内置根）：自建端点、企业代理 MITM、
        // 自签 CA 都能验证；ureq 默认的 WebPki 打包根证书在 native-tls 下会
        // disable_built_in_roots(true)，遇到不在该包的链就报 "unable to find any user-specified roots"。
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .root_certs(ureq::tls::RootCerts::PlatformVerifier)
            .build();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(60)))
            .build()
            .into();
        Ok(Self {
            cfg,
            creds,
            scheme,
            authority,
            agent,
        })
    }

    fn host(&self) -> String {
        if self.cfg.path_style {
            self.authority.clone()
        } else {
            format!("{}.{}", self.cfg.bucket, self.authority)
        }
    }

    /// 请求路径（已百分号编码）。key 为空表示桶级操作（List）。
    fn request_path(&self, key: &str) -> String {
        let mut p = String::new();
        if self.cfg.path_style {
            p.push('/');
            p.push_str(&sign::uri_encode(&self.cfg.bucket, false));
        }
        if key.is_empty() {
            if !self.cfg.path_style {
                p.push('/');
            }
        } else {
            for seg in key.split('/') {
                p.push('/');
                p.push_str(&sign::uri_encode(seg, false));
            }
        }
        p
    }

    fn payload_hash(body: Option<&[u8]>) -> String {
        match body {
            Some(b) if !b.is_empty() => sign::sha256_hex(b),
            _ => sign::EMPTY_PAYLOAD_SHA256.to_string(),
        }
    }

    /// 统一出口：签名 → 发送 → 状态码 + body。非 2xx 不视为传输错误，
    /// 由调用方按语义判定（404 在 get 里是 None）。
    fn execute(
        &self,
        method: &str,
        key: &str,
        query: &[(String, String)],
        body: Option<&[u8]>,
        content_type: Option<&str>,
    ) -> Result<(u16, Vec<u8>, Option<String>), String> {
        let path = self.request_path(key);
        let host = self.host();
        self.send_raw(method, &host, &path, query, body, content_type)
    }

    fn send_raw(
        &self,
        method: &str,
        host: &str,
        path: &str,
        query: &[(String, String)],
        body: Option<&[u8]>,
        content_type: Option<&str>,
    ) -> Result<(u16, Vec<u8>, Option<String>), String> {
        let cq = sign::canonical_query(query);
        let mut url = format!("{}://{host}{path}", self.scheme);
        if !cq.is_empty() {
            url.push('?');
            url.push_str(&cq);
        }
        let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let payload_hash = Self::payload_hash(body);
        let auth = sign::authorization(
            &sign::SignRequest {
                method,
                host,
                canonical_uri: path,
                canonical_query: &cq,
                payload_sha256: &payload_hash,
                amz_date: &amz_date,
                region: &self.cfg.region,
                service: "s3",
            },
            &self.creds,
        );

        let res = match method {
            "GET" | "HEAD" => {
                let mut rb = if method == "GET" {
                    self.agent.get(&url)
                } else {
                    self.agent.head(&url)
                }
                .header("x-amz-date", &amz_date)
                .header("x-amz-content-sha256", &payload_hash)
                .header("authorization", &auth);
                if let Some(t) = self.creds.session_token.as_deref().filter(|s| !s.is_empty()) {
                    rb = rb.header("x-amz-security-token", t);
                }
                rb.call()
            }
            "PUT" => {
                let mut rb = self
                    .agent
                    .put(&url)
                    .header("x-amz-date", &amz_date)
                    .header("x-amz-content-sha256", &payload_hash)
                    .header("authorization", &auth);
                if let Some(t) = self.creds.session_token.as_deref().filter(|s| !s.is_empty()) {
                    rb = rb.header("x-amz-security-token", t);
                }
                if let Some(ct) = content_type {
                    rb = rb.header("content-type", ct);
                }
                rb.send(body.unwrap_or_default())
            }
            "DELETE" => {
                let mut rb = self
                    .agent
                    .delete(&url)
                    .header("x-amz-date", &amz_date)
                    .header("x-amz-content-sha256", &payload_hash)
                    .header("authorization", &auth);
                if let Some(t) = self.creds.session_token.as_deref().filter(|s| !s.is_empty()) {
                    rb = rb.header("x-amz-security-token", t);
                }
                rb.call()
            }
            other => return Err(format!("不支持的 HTTP 方法: {other}")),
        };

        let mut resp = res.map_err(|e| match e {
            ureq::Error::StatusCode(code) => format!("S3 请求返回状态 {code}（{method} {url}）"),
            other => format!("S3 请求失败（{method} {url}）: {other}"),
        })?;
        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = if method == "HEAD" {
            Vec::new()
        } else {
            resp.body_mut()
                .read_to_vec()
                .map_err(|e| format!("读取 S3 响应失败: {e}"))?
        };
        Ok((status, bytes, content_type))
    }

    /// ListBuckets（GET /，不带 bucket 路径）。仅用于 403 诊断：把"桶名写错"
    /// 这种最常见的原因直接摆在错误信息里。失败则静默忽略。
    fn list_bucket_names(&self) -> Option<Vec<String>> {
        let (status, body, _) = self
            .send_raw("GET", &self.authority, "/", &[], None, None)
            .ok()?;
        if !(200..300).contains(&status) {
            return None;
        }
        let text = String::from_utf8_lossy(&body);
        let mut names = xml_tag_texts(&text, "Name");
        names.sort();
        names.dedup();
        names.retain(|n| !n.is_empty());
        Some(names)
    }

    fn status_error(&self, op: &str, key: &str, status: u16, body: &[u8]) -> String {
        let text = String::from_utf8_lossy(body);
        let code = xml_tag_text(&text, "Code").unwrap_or_default();
        let msg = xml_tag_text(&text, "Message").unwrap_or_default();
        let mut hint = match status {
            403 => "（检查 Access Key/Secret、region、以及该桶的对象读写权限）".to_string(),
            404 => "（检查 bucket 名与 endpoint 是否匹配）".to_string(),
            _ => String::new(),
        };
        if status == 403
            && let Some(names) = self.list_bucket_names()
            && !names.is_empty()
        {
            hint.push_str(&format!(
                "\n该密钥可见的桶：{} —— 请核对 bucket 是否写错",
                names.join(", ")
            ));
        }
        format!(
            "{op} 失败 [{status} {code}] {msg} — {} key={key}{hint}",
            self.describe()
        )
    }
}

impl ObjectStore for S3Store {
    fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String> {
        let (status, resp, _) = self.execute("PUT", key, &[], Some(body), Some(content_type))?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(self.status_error("上传对象", key, status, &resp))
        }
    }

    fn get(&self, key: &str) -> Result<Option<Object>, String> {
        let (status, body, content_type) = self.execute("GET", key, &[], None, None)?;
        match status {
            200..=299 => Ok(Some(Object { body, content_type })),
            404 => Ok(None),
            s => Err(self.status_error("下载对象", key, s, &body)),
        }
    }

    fn head(&self, key: &str) -> Result<bool, String> {
        let (status, body, _) = self.execute("HEAD", key, &[], None, None)?;
        match status {
            200..=299 => Ok(true),
            404 => Ok(false),
            s => Err(self.status_error("探测对象", key, s, &body)),
        }
    }

    fn list(
        &self,
        prefix: &str,
        start_after: Option<&str>,
        delimiter: Option<&str>,
    ) -> Result<ListResult, String> {
        let mut q: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1000".into()),
        ];
        if !prefix.is_empty() {
            q.push(("prefix".into(), prefix.to_string()));
        }
        if let Some(s) = start_after.filter(|s| !s.is_empty()) {
            q.push(("start-after".into(), s.to_string()));
        }
        if let Some(d) = delimiter {
            q.push(("delimiter".into(), d.to_string()));
        }
        let (status, body, _) = self.execute("GET", "", &q, None, None)?;
        if !(200..300).contains(&status) {
            return Err(self.status_error("列举对象", prefix, status, &body));
        }
        let text = String::from_utf8_lossy(&body);
        let mut out = ListResult {
            keys: xml_tag_texts(&text, "Key"),
            common_prefixes: xml_blocks(&text, "CommonPrefixes")
                .into_iter()
                .filter_map(|b| xml_tag_text(b, "Prefix"))
                .collect(),
            truncated: xml_tag_text(&text, "IsTruncated").as_deref() == Some("true"),
        };
        out.sort_dedup();
        Ok(out)
    }

    fn first_key(&self, prefix: &str) -> Result<Option<String>, String> {
        let mut q: Vec<(String, String)> = vec![
            ("list-type".into(), "2".into()),
            ("max-keys".into(), "1".into()),
        ];
        if !prefix.is_empty() {
            q.push(("prefix".into(), prefix.to_string()));
        }
        let (status, body, _) = self.execute("GET", "", &q, None, None)?;
        if !(200..300).contains(&status) {
            return Err(self.status_error("列举对象", prefix, status, &body));
        }
        let text = String::from_utf8_lossy(&body);
        Ok(xml_tag_texts(&text, "Key").into_iter().next())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        let (status, body, _) = self.execute("DELETE", key, &[], None, None)?;
        match status {
            200..=299 | 404 => Ok(()),
            s => Err(self.status_error("删除对象", key, s, &body)),
        }
    }

    fn describe(&self) -> String {
        format!(
            "bucket={} endpoint={}://{} prefix={} path_style={}",
            self.cfg.bucket,
            self.scheme,
            self.authority,
            self.cfg.norm_prefix(),
            self.cfg.path_style
        )
    }
}

fn split_endpoint(ep: &str) -> Result<(String, String), String> {
    let ep = ep.trim().trim_end_matches('/');
    if ep.is_empty() {
        return Err("S3 endpoint 不能为空".into());
    }
    let (scheme, rest) = if let Some(r) = ep.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = ep.strip_prefix("http://") {
        ("http", r)
    } else {
        ("https", ep)
    };
    if rest.is_empty() {
        return Err("S3 endpoint 缺少主机名".into());
    }
    if rest.contains('/') {
        return Err(format!(
            "S3 endpoint 不应包含路径（`{rest}`）；bucket 请单独填写"
        ));
    }
    if rest.chars().any(char::is_whitespace) {
        return Err("S3 endpoint 含空白字符".into());
    }
    Ok((scheme.to_string(), rest.to_string()))
}

// ---------------------------------------------------------------------------
// 极简 XML 取值（ListObjectsV2 响应）：只处理我们需要的三种标签，
// 不引入 XML 依赖。响应键由本应用生成（数字/十六进制/uuid/'-'/'/'），
// 仍做实体反转义以兼容自建端点返回前缀中的特殊字符。
// ---------------------------------------------------------------------------

fn xml_blocks<'a>(body: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut pos = 0usize;
    while let Some(i) = body[pos..].find(&open) {
        let start = pos + i + open.len();
        let Some(j) = body[start..].find(&close) else {
            break;
        };
        out.push(&body[start..start + j]);
        pos = start + j + close.len();
    }
    out
}

/// 第一个同名标签的文本（已反转义）
fn xml_tag_text(body: &str, tag: &str) -> Option<String> {
    xml_blocks(body, tag).first().map(|s| xml_unescape(s))
}

/// 全部同名标签文本（已反转义）
fn xml_tag_texts(body: &str, tag: &str) -> Vec<String> {
    xml_blocks(body, tag)
        .into_iter()
        .map(xml_unescape)
        .collect()
}

fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let Some(semi) = rest[amp..].find(';') else {
            out.push_str(&rest[amp..]);
            return out;
        };
        let ent = &rest[amp + 1..amp + semi];
        let rep = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse::<u32>().ok()))
                .and_then(char::from_u32),
        };
        match rep {
            Some(c) => {
                out.push(c);
                rest = &rest[amp + semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[amp + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// 内存实现（测试 / 离线演练）
// ---------------------------------------------------------------------------

#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    objects: std::cell::RefCell<BTreeMap<String, (Vec<u8>, String)>>,
}
#[cfg(test)]
impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn keys(&self) -> Vec<String> {
        self.objects.borrow().keys().cloned().collect()
    }

    /// 桶内对象总字节数（测试用：断言"日常多轮上传"不会越滚越大）
    pub fn total_bytes(&self) -> usize {
        self.objects.borrow().values().map(|(b, _)| b.len()).sum()
    }
}

#[cfg(test)]
impl ObjectStore for MemoryStore {
    fn put(&self, key: &str, body: &[u8], content_type: &str) -> Result<(), String> {
        self.objects
            .borrow_mut()
            .insert(key.to_string(), (body.to_vec(), content_type.to_string()));
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<Object>, String> {
        Ok(self.objects.borrow().get(key).map(|(b, ct)| Object {
            body: b.clone(),
            content_type: Some(ct.clone()),
        }))
    }

    fn head(&self, key: &str) -> Result<bool, String> {
        Ok(self.objects.borrow().contains_key(key))
    }

    fn list(
        &self,
        prefix: &str,
        start_after: Option<&str>,
        delimiter: Option<&str>,
    ) -> Result<ListResult, String> {
        let objs = self.objects.borrow();
        let mut out = ListResult::default();
        for key in objs.keys() {
            if !key.starts_with(prefix) {
                continue;
            }
            if let Some(s) = start_after
                && key.as_str() <= s
            {
                continue;
            }
            match delimiter {
                Some(d) if !d.is_empty() => {
                    let rest = &key[prefix.len()..];
                    if let Some(i) = rest.find(d) {
                        out.common_prefixes
                            .push(format!("{prefix}{}", &rest[..i + d.len()]));
                    } else {
                        out.keys.push(key.clone());
                    }
                }
                _ => out.keys.push(key.clone()),
            }
        }
        out.truncated = out.keys.len() > 1000;
        out.keys.truncate(1000);
        out.sort_dedup();
        Ok(out)
    }

    fn first_key(&self, prefix: &str) -> Result<Option<String>, String> {
        Ok(self
            .objects
            .borrow()
            .keys()
            .find(|k| k.starts_with(prefix))
            .cloned())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.objects.borrow_mut().remove(key);
        Ok(())
    }

    fn describe(&self) -> String {
        "memory://".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds() -> Credentials {
        Credentials {
            access_key: "a".into(),
            secret_key: "b".into(),
            session_token: None,
        }
    }

    fn cfg() -> S3Config {
        S3Config {
            endpoint: "https://s3.us-east-1.amazonaws.com".into(),
            region: "us-east-1".into(),
            bucket: "examplebucket".into(),
            prefix: "qbank".into(),
            path_style: true,
        }
    }

    #[test]
    fn tls_provider_is_explicitly_native_tls() {
        // 回归：默认 provider 是 Rustls，未显式指定时 https 请求会 panic
        let s = S3Store::new(cfg(), creds()).unwrap();
        let tls = s.agent.config().tls_config();
        assert_eq!(tls.provider(), ureq::tls::TlsProvider::NativeTls);
        assert!(matches!(
            tls.root_certs(),
            ureq::tls::RootCerts::PlatformVerifier
        ));
    }

    #[test]
    fn key_layout_is_versioned_and_prefix_scoped() {
        let c = cfg();
        assert_eq!(c.full_key("log/dev-a/00000001.ndjson.gz"), "qbank/v1/log/dev-a/00000001.ndjson.gz");
        assert_eq!(c.full_key(""), "qbank/v1/");
        let mut c2 = cfg();
        c2.prefix = "  /  ".into();
        assert_eq!(c2.full_key("manifest.json"), "v1/manifest.json");
        assert_eq!(c2.full_key(""), "v1/");
    }

    #[test]
    fn endpoint_normalization_and_guards() {
        assert_eq!(
            split_endpoint("minio.local:9000").unwrap(),
            ("https".to_string(), "minio.local:9000".to_string())
        );
        assert_eq!(
            split_endpoint("http://127.0.0.1:9000/").unwrap(),
            ("http".to_string(), "127.0.0.1:9000".to_string())
        );
        assert!(split_endpoint("https://host/bucket").is_err());
        assert!(split_endpoint("   ").is_err());
        // 虚拟主机风格 + 端口 → 明确报错，不静默发错请求
        let mut c = cfg();
        c.endpoint = "http://minio.local:9000".into();
        c.path_style = false;
        assert!(S3Store::new(c, creds()).is_err());
    }

    #[test]
    fn request_path_variants() {
        let mut c = cfg();
        c.path_style = true;
        let s = S3Store::new(c, creds()).unwrap();
        assert_eq!(s.request_path(""), "/examplebucket");
        assert_eq!(s.request_path("qbank/v1/a b.png"), "/examplebucket/qbank/v1/a%20b.png");

        let mut c2 = cfg();
        c2.path_style = false;
        let s2 = S3Store::new(c2, creds()).unwrap();
        assert_eq!(s2.request_path(""), "/");
        assert_eq!(s2.host(), "examplebucket.s3.us-east-1.amazonaws.com");
    }

    #[test]
    fn xml_list_parsing() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>examplebucket</Name><Prefix>qbank/v1/log/</Prefix><KeyCount>2</KeyCount>
<IsTruncated>true</IsTruncated>
<Contents><Key>qbank/v1/log/dev-a/00000001.ndjson.gz</Key><Size>12</Size></Contents>
<Contents><Key>qbank/v1/log/dev-a/00000002.ndjson.gz</Key><Size>34</Size></Contents>
<CommonPrefixes><Prefix>qbank/v1/log/dev-b/</Prefix></CommonPrefixes>
</ListBucketResult>"#;
        let keys = xml_tag_texts(xml, "Key");
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0], "qbank/v1/log/dev-a/00000001.ndjson.gz");
        // KeyCount 不得被当成 Key
        assert!(keys.iter().all(|k| !k.contains('2') || k.contains("0000000")));
        let cps: Vec<String> = xml_blocks(xml, "CommonPrefixes")
            .into_iter()
            .filter_map(|b| xml_tag_text(b, "Prefix"))
            .collect();
        assert_eq!(cps, vec!["qbank/v1/log/dev-b/".to_string()]);
        assert_eq!(xml_tag_text(xml, "IsTruncated").as_deref(), Some("true"));
    }

    #[test]
    fn xml_unescape_handles_entities() {
        assert_eq!(xml_unescape("a&amp;b&lt;c&gt;d&quot;e&apos;f"), "a&b<c>d\"e'f");
        assert_eq!(xml_unescape("&#x8bbe;&#22791;"), "设备");
        assert_eq!(xml_unescape("无实体"), "无实体");
    }

    #[test]
    fn memory_store_list_semantics() {
        let m = MemoryStore::new();
        m.put("p/v1/log/a/1", b"x", "text/plain").unwrap();
        m.put("p/v1/log/a/2", b"y", "text/plain").unwrap();
        m.put("p/v1/log/b/1", b"z", "text/plain").unwrap();
        m.put("p/v1/assets/aa/bb", b"i", "image/png").unwrap();

        let all = m.list("p/v1/log/", None, None).unwrap();
        assert_eq!(all.keys.len(), 3);

        let after = m.list("p/v1/log/", Some("p/v1/log/a/1"), None).unwrap();
        assert_eq!(after.keys, vec!["p/v1/log/a/2".to_string(), "p/v1/log/b/1".to_string()]);

        let by_dev = m.list("p/v1/log/", None, Some("/")).unwrap();
        assert_eq!(by_dev.common_prefixes, vec!["p/v1/log/a/".to_string(), "p/v1/log/b/".to_string()]);
        assert!(by_dev.keys.is_empty());

        assert!(m.head("p/v1/log/a/1").unwrap());
        assert!(m.get("p/v1/log/missing").unwrap().is_none());
        m.delete("p/v1/log/a/1").unwrap();
        assert!(!m.head("p/v1/log/a/1").unwrap());
    }
}
