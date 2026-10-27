//! S3 通道的线上格式：NDJSON 信封 + gzip。
//!
//! 选择 NDJSON 而非单个 JSON 文档的理由：
//! - 一行一条独立记录 → 可以逐行流式解析、按行裁剪，不需要整包读进内存；
//! - 行标签自带类型，缺字段/多字段的行由 `apply_bundle` 按既有规则拒收，
//!   不会因为一处脏数据炸掉整包；
//! - 与「增量日志 = 追加对象」的对象存储模型天然对齐。
//!
//! 首行是信封头（`k:"h"`，含格式版本、设备、序号、前序序号、导出边界），
//! 其余行是 `{k:<数组名>, ...行}`。数组名与 `apply_bundle` 的 bundle 键完全一致
//! （banks/questions/records/review_state/wrong_dismiss/settings/tombstones）。

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};
use std::io::{Read, Write};

/// 与 `apply_bundle` bundle 的 7 个数组一一对应（顺序无关，仅用于稳定编码）
pub const ARRAY_KEYS: [&str; 7] = [
    "banks",
    "questions",
    "records",
    "review_state",
    "wrong_dismiss",
    "settings",
    "tombstones",
];

pub const HEADER_TAG: &str = "h";
pub const FORMAT_VERSION: u32 = 1;

fn empty_bundle() -> Value {
    let mut m = Map::new();
    for k in ARRAY_KEYS {
        m.insert(k.to_string(), json!([]));
    }
    Value::Object(m)
}

/// (header, bundle) → 未压缩 NDJSON 字节
pub fn encode(header: &Value, bundle: &Value) -> Result<Vec<u8>, String> {
    let mut h = header.clone();
    let obj = h
        .as_object_mut()
        .ok_or("wire: header 必须是 JSON 对象")?;
    obj.insert("k".into(), json!(HEADER_TAG));
    obj.insert("format".into(), json!(FORMAT_VERSION));
    let mut out = Vec::new();
    out.extend_from_slice(
        serde_json::to_string(&h)
            .map_err(|e| format!("wire: 序列化 header 失败: {e}"))?
            .as_bytes(),
    );
    out.push(b'\n');
    for key in ARRAY_KEYS {
        for row in bundle
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if !row.is_object() {
                return Err(format!("wire: {key} 中存在非对象行"));
            }
            let mut m = row.clone();
            let obj = m.as_object_mut().expect("已校验为对象");
            if obj.contains_key("k") {
                return Err(format!("wire: {key} 的行自带保留键 `k`"));
            }
            obj.insert("k".into(), json!(key));
            out.extend_from_slice(
                serde_json::to_string(&m)
                    .map_err(|e| format!("wire: 序列化行失败: {e}"))?
                    .as_bytes(),
            );
            out.push(b'\n');
        }
    }
    Ok(out)
}

/// 未压缩 NDJSON 字节 → (header, bundle)。空行忽略；未知标签/版本直接报错（脏包响亮失败）。
pub fn decode(raw: &[u8]) -> Result<(Value, Value), String> {
    let text = std::str::from_utf8(raw).map_err(|_| "wire: 包不是合法 UTF-8".to_string())?;
    let mut header: Option<Value> = None;
    let mut bundle = empty_bundle();
    for (idx, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: Value = serde_json::from_str(line)
            .map_err(|e| format!("wire: 第 {} 行不是合法 JSON: {e}", idx + 1))?;
        let tag = v
            .get("k")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("wire: 第 {} 行缺少行标签", idx + 1))?
            .to_string();
        if header.is_none() {
            if tag != HEADER_TAG {
                return Err("wire: 首行必须是信封头（k:\"h\"）".into());
            }
            let fmt = v.get("format").and_then(Value::as_u64).unwrap_or(0);
            if fmt != u64::from(FORMAT_VERSION) {
                return Err(format!(
                    "wire: 不支持的包格式版本 {fmt}（本机支持 {FORMAT_VERSION}）"
                ));
            }
            header = Some(v);
            continue;
        }
        if tag == HEADER_TAG {
            return Err(format!("wire: 第 {} 行出现重复信封头", idx + 1));
        }
        let mut row = v;
        row.as_object_mut().expect("已校验").remove("k");
        let arr = bundle
            .get_mut(&tag)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| format!("wire: 第 {} 行标签 `{tag}` 未知", idx + 1))?;
        arr.push(row);
    }
    let header = header.ok_or("wire: 包为空（缺少信封头）")?;
    Ok((header, bundle))
}

pub fn gzip_encode(raw: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::new(6));
    enc.write_all(raw)
        .map_err(|e| format!("gzip 压缩失败: {e}"))?;
    enc.finish().map_err(|e| format!("gzip 压缩失败: {e}"))
}

pub fn gzip_decode(gz: &[u8]) -> Result<Vec<u8>, String> {
    let mut dec = GzDecoder::new(gz);
    let mut out = Vec::new();
    dec.read_to_end(&mut out)
        .map_err(|e| format!("gzip 解压失败（对象可能被截断或非 gzip 格式）: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (Value, Value) {
        let header = json!({
            "device": "dev-a", "seq": 7, "prev_seq": 6,
            "since": "2026-09-10T00:00:00.000Z",
            "exported_at": "2026-09-10T12:00:00.000Z",
            "full": false,
        });
        let bundle = json!({
            "banks": [{"id": "b1", "name": "库一"}],
            "questions": [{"id": "q1", "bank_id": "b1"}],
            "records": [{"id": "r1", "question_id": "q1"}],
            "review_state": [{"question_id": "q1", "due_at": "2026-10-01T00:00:00.000Z"}],
            "wrong_dismiss": [{"question_id": "q1", "is_dismissed": 1}],
            "settings": [{"key": "fsrs.requestRetention", "value_json": "0.9"}],
            "tombstones": [{"entity_type": "question", "entity_id": "q0"}],
        });
        (header, bundle)
    }

    #[test]
    fn roundtrip_preserves_rows_and_header() {
        let (h, b) = sample();
        let raw = encode(&h, &b).unwrap();
        let text = String::from_utf8(raw.clone()).unwrap();
        assert_eq!(text.lines().count(), 1 + 7);
        assert!(text.lines().next().unwrap().contains("\"format\":1"));

        let (h2, b2) = decode(&raw).unwrap();
        assert_eq!(h2["device"], json!("dev-a"));
        assert_eq!(h2["seq"], json!(7));
        assert_eq!(b2["banks"][0]["id"], json!("b1"));
        assert_eq!(b2["questions"][0]["id"], json!("q1"));
        assert_eq!(b2["wrong_dismiss"][0]["is_dismissed"], json!(1));
        assert_eq!(b2["settings"][0]["key"], json!("fsrs.requestRetention"));
        assert_eq!(b2["tombstones"][0]["entity_id"], json!("q0"));
        // 行标签 `k` 不得泄漏进 bundle 行
        assert!(b2["banks"][0].get("k").is_none());
    }

    #[test]
    fn missing_arrays_decode_as_empty_arrays() {
        let (h, _) = sample();
        let mut b = json!({"banks": [{"id": "b1"}]});
        let raw = encode(&h, &b).unwrap();
        let (_, b2) = decode(&raw).unwrap();
        assert_eq!(b2["banks"].as_array().unwrap().len(), 1);
        for k in ARRAY_KEYS {
            assert!(b2[k].is_array(), "{k} 必须是数组");
        }
        b["banks"] = json!([]);
        let _ = b;
    }

    #[test]
    fn gzip_roundtrip() {
        let (h, b) = sample();
        let raw = encode(&h, &b).unwrap();
        let gz = gzip_encode(&raw).unwrap();
        assert!(gz.len() < raw.len() + 64, "小包压缩后不应显著膨胀");
        assert_eq!(gzip_decode(&gz).unwrap(), raw);
    }

    #[test]
    fn rejects_bad_packets() {
        // 首行不是头
        assert!(decode(b"{\"k\":\"banks\",\"id\":\"b1\"}\n").is_err());
        // 版本不符
        assert!(decode(b"{\"k\":\"h\",\"format\":99}\n").is_err());
        // 未知标签
        assert!(decode(b"{\"k\":\"h\",\"format\":1}\n{\"k\":\"nope\"}\n").is_err());
        // 空包
        assert!(decode(b"").is_err());
        // 行内自带保留键 k
        let h = json!({"device": "d"});
        let b = json!({"banks": [{"k": "evil", "id": "b1"}]});
        assert!(encode(&h, &b).is_err());
        // 截断的 gzip
        let raw = encode(&json!({"device": "d"}), &json!({"banks": [{"id": "b1"}]})).unwrap();
        let gz = gzip_encode(&raw).unwrap();
        assert!(gzip_decode(&gz[..gz.len() - 8]).is_err());
    }

    #[test]
    fn blank_lines_are_tolerated() {
        let (h, b) = sample();
        let raw = encode(&h, &b).unwrap();
        let mut padded = raw.clone();
        padded.extend_from_slice(b"\n\n");
        let (h2, b2) = decode(&padded).unwrap();
        assert_eq!(h2["device"], json!("dev-a"));
        assert_eq!(b2["banks"].as_array().unwrap().len(), 1);
    }
}
