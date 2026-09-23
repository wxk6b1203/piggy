//! JSONL 分帧器（docs/02 §1）
//!
//! 协议要求：只以 LF（`\n`）切分记录；接受可选尾部 `\r`（剥离）。
//! 按**字节**扫描 `b'\n'`：UTF-8 多字节序列的续字节最高位恒为 1，
//! 不可能等于 0x0A，因此天然规避 U+2028/U+2029 行分隔符陷阱。
//! 跨 chunk 的半行必须缓冲；EOF 时冲刷最后的半行（无换行结尾）。

/// 无外部依赖、可单测的纯分帧器。
pub struct JsonlDecoder {
    buf: Vec<u8>,
}

impl JsonlDecoder {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(16 * 1024),
        }
    }

    /// 喂入一个 chunk，产出所有完整行（已剥 `\r`，跳过空行）。
    pub fn feed(&mut self, chunk: &[u8], out: &mut Vec<String>) {
        self.buf.extend_from_slice(chunk);
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // 丢弃 '\n'
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
    }

    /// 流结束（EOF）：冲刷残留半行。
    pub fn finish(&mut self, out: &mut Vec<String>) {
        if self.buf.is_empty() {
            return;
        }
        let mut line = std::mem::take(&mut self.buf);
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        if !line.is_empty() {
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
    }
}

impl Default for JsonlDecoder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_chunks(chunks: &[&[u8]]) -> Vec<String> {
        let mut d = JsonlDecoder::new();
        let mut out = Vec::new();
        for c in chunks {
            d.feed(c, &mut out);
        }
        d.finish(&mut out);
        out
    }

    #[test]
    fn basic_lines() {
        let lines = feed_chunks(&[b"{\"a\":1}\n{\"a\":2}\n"]);
        assert_eq!(lines, vec!["{\"a\":1}", "{\"a\":2}"]);
    }

    #[test]
    fn crlf_stripped() {
        let lines = feed_chunks(&[b"{\"a\":1}\r\n{\"a\":2}\r\n"]);
        assert_eq!(lines, vec!["{\"a\":1}", "{\"a\":2}"]);
    }

    #[test]
    fn half_line_across_chunks() {
        // 半行跨 chunk：{"a":"hel + lo"}\n
        let lines = feed_chunks(&[b"{\"a\":\"hel", b"lo\"}\n"]);
        assert_eq!(lines, vec!["{\"a\":\"hello\"}"]);
    }

    #[test]
    fn multibyte_char_split_across_chunks() {
        // 中文多字节字符被 chunk 边界切开
        let s = "{\"t\":\"你好世界\"}\n";
        let bytes = s.as_bytes();
        let mid = 9; // 切在多字节序列中间
        let lines = feed_chunks(&[&bytes[..mid], &bytes[mid..]]);
        assert_eq!(lines[0], "{\"t\":\"你好世界\"}");
    }

    #[test]
    fn u2028_u2029_are_content_not_separators() {
        // U+2028 (E2 80 A8) / U+2029 (E2 80 A9) 必须留在行内
        let payload = "{\"s\":\"a\u{2028}b\u{2029}c\"}";
        let joined = format!("{}\n", payload);
        let lines = feed_chunks(&[joined.as_bytes()]);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], payload);
    }

    #[test]
    fn one_mb_single_line() {
        // >1MB 单行（如巨型 base64 附件事件，C7）
        let big = format!("{{\"data\":\"{}\"}}", "x".repeat(1_100_000));
        let raw = format!("{}\n", big);
        let mut d = JsonlDecoder::new();
        let mut out = Vec::new();
        // 按 64KB 块喂入，模拟管道分片
        for chunk in raw.as_bytes().chunks(64 * 1024) {
            d.feed(chunk, &mut out);
        }
        d.finish(&mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), big.len());
    }

    #[test]
    fn eof_without_trailing_newline() {
        let lines = feed_chunks(&[b"{\"a\":1}\n{\"a\":2}"]);
        assert_eq!(lines, vec!["{\"a\":1}", "{\"a\":2}"]);
    }

    #[test]
    fn empty_lines_skipped() {
        let lines = feed_chunks(&[b"\n\n{\"a\":1}\n\n"]);
        assert_eq!(lines, vec!["{\"a\":1}"]);
    }

    #[test]
    fn many_small_chunks() {
        let s = "{\"k\":\"v\"}\n";
        let mut d = JsonlDecoder::new();
        let mut out = Vec::new();
        for b in s.as_bytes() {
            d.feed(&[*b], &mut out);
        }
        d.finish(&mut out);
        assert_eq!(out, vec!["{\"k\":\"v\"}"]);
    }
}
