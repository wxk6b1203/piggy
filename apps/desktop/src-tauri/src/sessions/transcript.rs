//! 会话转录分页读（docs/03 §2.19）。
//!
//! ## 为什么不再一次把整段历史读进来
//!
//! 打开会话时前端原先调 `get_messages`（pi 进程内存里的当前上下文），一次性 hydrate
//! 整段历史。真机实测（2026-09-23，`~/Documents/Project/tmp/session` 里最大的那个会话）：
//!
//! | 文件 | 大小 | 行数 | 最后 10 行 | 最后 50 行 |
//! |---|---|---|---|---|
//! | `2026-09-21T14-18-43-680Z_01a0c455…jsonl` | 11.7 MB | 1070 | 17 KB | 269 KB |
//!
//! 11.7 MB 里有 6.96 MB 集中在 3 行超长 `toolResult` 上（3.35 MB / 2.05 MB / 1.56 MB）。
//! 也就是说：**要看的最后 50 行只占全文件的 2.3%**，另外 97% 是打开时必须等、
//! 却一眼都不会看的旧工具输出。这里改成**从文件尾往回读**——打开只读一页，
//! 往上的历史按需再读（前端「加载更早」）。
//!
//! ## 与 pi 的一致性
//!
//! * **行 = pi 的 durable 条目**（`session-manager.ts` 的 `SessionEntry`）：
//!   `{"type":"message","id":…,"parentId":…,"message":{…}}`、`{"type":"compaction",…}`…
//!   所以「一页」的单位是**条目**，不是消息——否则分页边界会落在一次工具调用的中间。
//! * **活动分支 = 文件最后一条条目往根走的那条链**：pi 打开会话时也是这样定叶子的
//!   （`session-manager.ts` 的 `_buildIndex`：`leafId` 逐条覆盖成最后一个条目）。
//!   线性文件（本机 28 个真实会话、5299 个 parentId 链接，实测 **0 处断裂**）
//!   走快路径；一旦在窗口里发现链断了（`/fork` 之类留下的分支），退回慢路径
//!   ——整文件扫一遍、按 parentId 追叶子到根——绝不把别的分支的内容混进转录。
//! * **投影规则**（哪些条目进转录）与前端渲染器**一一对应**：
//!   `user` / `assistant` / `toolResult` / `bashExecution`（`MessageView.tsx` 四种），
//!   外加 `compaction`（DSH 对话里的「上下文已压缩」行）。
//!
//! `system` 不进转录（前端 `pushMessage` 本来就跳过它），`custom` / `context_edit` /
//! 模型变更等只在轨迹视图里呈现。**一页 = 一页看得见的行**：否则「加载更早」可能翻出
//! 一页全是渲染不出来的条目，用户点了却什么也没发生。
//!
//! ## 游标
//!
//! 游标是**字节偏移**（`start_offset` = 本页第一行在文件里的起始偏移）。
//! 取更早的一页就是把 `start_offset` 传回来。用字节偏移而不是行号/条目 id：
//! 行号要全文件数一遍才知道，id 要全文件找一遍才定位得到——两者都会把
//! 「打开只读一页」变成「打开读整个文件」。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::{json, Value};

/// 默认每页条目数。50 行按 DSH 的估算行高（~88px）远超一屏，够贴底渲染。
pub const DEFAULT_LIMIT: usize = 50;
/// 每页最多允许请求多少条（挡住前端传入的离谱值）。
pub const MAX_LIMIT: usize = 500;
/// 反向扫描的分块大小：64 KiB。按块读而不是按行读，
/// 超长行（真机最大 3.35 MB）会跨很多块，靠 `prev_line` 的累积自动拼回来。
const CHUNK: usize = 64 * 1024;

/// 转录里的一行。
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// `user` / `assistant` / `toolResult` / `bashExecution` / `compaction`
    pub role: String,
    /// 交给前端的消息对象（`compaction` 行由这里合成，形状见 `compaction_row`）
    pub message: Value,
    /// 这一行在文件里的起始字节偏移（前端靠它把"轮次轮廓"和"已载入的行"对上）
    pub offset: u64,
}

/// 一页转录（`rows` 按时间正序：最老的在前）。
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub rows: Vec<Row>,
    /// 本页第一行的字节偏移；把它当 `before` 传回来就是"再往前一页"
    pub start_offset: u64,
    /// 前面是否还有条目
    pub has_more: bool,
    /// 后面是否还有更新的条目（本页不是文件尾部 → 界面要能"回到最新"）
    pub has_newer: bool,
    /// 是否走了"整文件追分支"的慢路径（真机线性文件恒为 false）
    pub branchy: bool,
}

impl Page {
    /// 转成前端要的 JSON（字段名与 `stores/messages.ts` 的分页字段对齐）。
    pub fn to_json(&self) -> Value {
        json!({
            "rows": self
                .rows
                .iter()
                .map(|r| json!({"role": r.role, "message": r.message, "offset": r.offset}))
                .collect::<Vec<_>>(),
            "startOffset": self.start_offset,
            "hasMore": self.has_more,
            "hasNewer": self.has_newer,
            "branchy": self.branchy,
        })
    }
}

/// 整段会话的**轮次轮廓**里的一轮。
///
/// 这是"刻度梯覆盖全部会话、内容只载入一部分"（DSH `mergeTurnRailItems` 的
/// `turnOutline` 投影）所需的最小信息：这一轮的锚点 + 预览文字。
#[derive(Debug, Clone, PartialEq)]
pub struct OutlineTurn {
    /// 第几轮，从 1 起（**绝对编号**，不随分页窗口变）
    pub turn: usize,
    /// 这一轮**用户那条消息**的起始字节偏移
    pub start: u64,
    /// 用户那条消息的结束偏移（= 跳转游标：`before = end` 正好取到这一轮）
    pub end: u64,
    /// 用户消息正文（已按 {@link EXCERPT_CAP} 截断，前端再按预览框宽度压）
    pub prompt: String,
    /// 这一轮助手的正文摘要（同上；可能为空）
    pub response: String,
}

/// 整段会话的轮次轮廓。
#[derive(Debug, Clone, PartialEq)]
pub struct Outline {
    pub turns: Vec<OutlineTurn>,
    pub total_bytes: u64,
}

impl Outline {
    pub fn to_json(&self) -> Value {
        json!({
            "turns": self
                .turns
                .iter()
                .map(|t| json!({
                    "turn": t.turn,
                    "start": t.start,
                    "end": t.end,
                    "prompt": t.prompt,
                    "response": t.response,
                }))
                .collect::<Vec<_>>(),
            "totalBytes": self.total_bytes,
        })
    }
}

/// 轮廓里每段正文最多取多少字符（前端预览框是 80/160，这里留足余量由前端再压）。
const EXCERPT_CAP: usize = 400;
/// 读 `"role"` 时只看行首这么多字节（见 [`fast_role`]）。
const ROLE_HEAD: usize = 256;


/// 读一页转录。
///
/// @param path - 会话 JSONL 文件
/// @param before - 右边界（不含）；`None` = 从文件尾读最后一页
/// @param limit - 每页条目数（0 或超限会被夹到合法区间）
/// @returns 一页转录
pub fn read_page(path: &Path, before: Option<u64>, limit: usize) -> Result<Page, String> {
    let mut file = File::open(path).map_err(|e| format!("{} 读取失败: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("{} 读取失败: {e}", path.display()))?
        .len();
    let limit = limit.clamp(1, MAX_LIMIT);
    let end = before.unwrap_or(len).min(len);

    // "后面还有更新的"= 本页的右边界没到文件尾。用字节比就行（不需要知道后面有没有
    // 可显示的行）：多给一次"回到最新"的机会，而它点了必然是对的。
    let has_newer = end < len;
    let fast = collect_back(&mut file, end, limit).map_err(|e| format!("读取失败: {e}"))?;
    if !fast.chain_broken {
        return Ok(Page {
            rows: fast.rows,
            start_offset: fast.start_offset,
            has_more: fast.has_more,
            has_newer,
            branchy: false,
        });
    }
    // 窗口里出现分支：快路径的"文件序 = 分支序"前提不成立了，退回整文件追叶子。
    let mut page = branch_window(&mut file, end, limit)?;
    page.has_newer = has_newer;
    Ok(page)
}

/* ────────────────────────── 快路径：从尾往回读 ────────────────────────── */

struct FastPage {
    rows: Vec<Row>,
    start_offset: u64,
    has_more: bool,
    /// 窗口内的 parentId 链断了（文件里有分支）→ 调用方改用慢路径
    chain_broken: bool,
}

fn collect_back(file: &mut File, end: u64, limit: usize) -> std::io::Result<FastPage> {
    let mut rows_rev: Vec<Row> = Vec::new();
    let mut pos = end;
    let mut start_offset = end;
    let mut chain_broken = false;
    // 反向扫描时"上一条（更靠后）条目的 parentId"——它应当等于接下来读到的那条的 id
    let mut expected_id: Option<String> = None;
    let mut first = true;

    while rows_rev.len() < limit && pos > 0 {
        let Some((line_start, bytes)) = prev_line(file, pos)? else {
            break;
        };
        start_offset = line_start;
        pos = line_start;
        let text = String::from_utf8_lossy(&bytes);
        let text = text.trim();
        if text.is_empty() {
            continue; // 空行：不占额度，也不算断链
        }
        let Ok(entry) = serde_json::from_str::<Value>(text) else {
            // 半行/坏行（pi 写到一半被杀）：跳过。它在 pi 那儿同样读不出来。
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue; // 文件头不在链上（pi 的 _buildIndex 也跳过它）
        }
        let id = entry.get("id").and_then(Value::as_str).map(str::to_string);
        let parent = entry.get("parentId").and_then(Value::as_str).map(str::to_string);
        if !first && expected_id.as_deref() != id.as_deref() {
            chain_broken = true;
            break;
        }
        first = false;
        expected_id = parent;
        if let Some(row) = row_of(&entry, line_start) {
            rows_rev.push(row);
        }
    }

    rows_rev.reverse();
    let has_more = rows_rev.len() >= limit && pos > 0;
    let empty = rows_rev.is_empty();
    Ok(FastPage {
        rows: rows_rev,
        start_offset: if empty { end } else { start_offset },
        has_more,
        chain_broken,
    })
}

/// 读出 `end`（不含）之前那一行：返回 `(行起始偏移, 行字节)`。
///
/// 行尾换行不属于返回的字节；文件首行（前面没有换行）会把该行原样返回
/// （调用方 `trim` 掉）。碰到文件头仍没找到换行 → `start = 0`。
fn prev_line(file: &mut File, end: u64) -> std::io::Result<Option<(u64, Vec<u8>)>> {
    if end == 0 {
        return Ok(None);
    }
    let mut buf: Vec<u8> = Vec::new(); // 已经扫过的更靠后部分
    let mut x = end;
    loop {
        let chunk_start = x.saturating_sub(CHUNK as u64);
        let mut chunk = vec![0u8; (x - chunk_start) as usize];
        file.seek(SeekFrom::Start(chunk_start))?;
        file.read_exact(&mut chunk)?;

        // 紧贴 `end` 的那个换行是**上一行的行尾**（x == end 时才是，即第一块）
        let skip_tail = buf.is_empty() && chunk.last() == Some(&b'\n');
        let search_end = if skip_tail { chunk.len() - 1 } else { chunk.len() };
        if let Some(i) = chunk[..search_end].iter().rposition(|b| *b == b'\n') {
            let mut line = chunk[i + 1..].to_vec();
            line.extend_from_slice(&buf);
            return Ok(Some((chunk_start + i as u64 + 1, line)));
        }
        let mut next = chunk;
        next.extend_from_slice(&buf);
        buf = next;
        if chunk_start == 0 {
            return Ok(Some((0, buf)));
        }
        x = chunk_start;
    }
}

/* ────────────────────── 慢路径：整文件追活动分支 ────────────────────── */

/// 有分支时的兜底：整文件扫一遍，从最后一个条目沿 parentId 追到根，
/// 在这条链上取 `before` 之前的一页。
fn branch_window(file: &mut File, end: u64, limit: usize) -> Result<Page, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    file.read_to_end(&mut raw).map_err(|e| e.to_string())?;

    let mut entries: Vec<(u64, Value)> = Vec::new(); // (起始偏移, 条目)，文件序
    let mut offset = 0u64;
    for slice in raw.split_inclusive(|b| *b == b'\n') {
        let line_start = offset;
        offset += slice.len() as u64;
        let text = String::from_utf8_lossy(slice);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<Value>(text) {
            if entry.get("type").and_then(Value::as_str) != Some("session") {
                entries.push((line_start, entry));
            }
        }
    }

    // 叶子 = 最后一个条目（pi `_buildIndex` 的 leafId 规则）
    let by_id: std::collections::HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, (_, e))| e.get("id").and_then(Value::as_str).map(|id| (id, i)))
        .collect();
    let mut chain: Vec<usize> = Vec::new();
    let mut cursor = entries.len().checked_sub(1);
    let mut guard = 0usize;
    while let Some(i) = cursor {
        chain.push(i);
        guard += 1;
        if guard > entries.len() + 1 {
            break; // parentId 成环：坏文件，别转死循环
        }
        cursor = entries[i]
            .1
            .get("parentId")
            .and_then(Value::as_str)
            .and_then(|p| by_id.get(p).copied());
    }
    chain.reverse(); // 根 → 叶子

    let visible: Vec<usize> = chain
        .into_iter()
        .filter(|i| entries[*i].0 < end)
        .filter(|i| row_of(&entries[*i].1, entries[*i].0).is_some())
        .collect();
    let take = visible.len().saturating_sub(limit);
    let window = &visible[take..];
    let rows: Vec<Row> = window
        .iter()
        .filter_map(|i| row_of(&entries[*i].1, entries[*i].0))
        .collect();
    let start_offset = window.first().map(|i| entries[*i].0).unwrap_or(end);
    Ok(Page {
        has_more: take > 0,
        has_newer: false, // 由 read_page 按右边界填（这里无从判断）
        rows,
        start_offset,
        branchy: true,
    })
}

/* ────────────────────── 整段会话的轮次轮廓（刻度梯用） ────────────────────── */

/// 扫一遍会话文件，产出**整段会话**的轮次轮廓：每一轮一个锚点 + 预览文字。
///
/// 为什么需要它：刻度梯要"预览全部、载入部分"（DSH `TurnNavigator` 的
/// `mergeTurnRailItems`：outline 给全部轮次、已载入的行覆盖同名轮次，
/// 未载入的锚点是 `kind: "unloaded"`，点它先把历史翻页进来）。
/// 只画"已载入的那部分"会让长会话的梯子丢掉整体形状——用户报的就是这个。
///
/// 成本：一次顺序扫（不反向、不随机读）。真机 11.7 MB / 1070 行的会话实测见
/// `--ignored real_machine_page`；大头是 3 行超长 `toolResult`，而它们靠
/// [`fast_role`] 直接跳过**不解析**——扫描成本因此与"可显示内容"成正比，
/// 而不是与文件大小成正比。
///
/// @param path - 会话 JSONL 文件
/// @returns 轮次轮廓（按轮次升序）
pub fn outline(path: &Path) -> Result<Outline, String> {
    let file = File::open(path).map_err(|e| format!("{} 读取失败: {e}", path.display()))?;
    let total_bytes = file
        .metadata()
        .map_err(|e| format!("{} 读取失败: {e}", path.display()))?
        .len();
    let mut reader = std::io::BufReader::with_capacity(CHUNK, file);

    let mut turns: Vec<OutlineTurn> = Vec::new();
    let mut offset = 0u64;
    let mut line: Vec<u8> = Vec::new();
    loop {
        line.clear();
        let n = std::io::BufRead::read_until(&mut reader, b'\n', &mut line)
            .map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break;
        }
        let start = offset;
        offset += n as u64;
        let end = offset;

        // 顺序很讲究：预筛要用**字节**做，且必须在 `from_utf8_lossy` **之前**。
        // 真机 11.7 MB 的会话里有 3 行共 6.96 MB 的工具输出，光是对它们做一次
        // UTF-8 校验 + 字符串化就要 20ms 以上；先按字节筛掉就完全不用碰。
        let raw = trim_ascii(&line);
        if raw.is_empty() {
            continue;
        }
        // 便宜的预筛：行首就能看出 role 且不是 user/assistant（toolResult/system…）
        // → 这一行对轮廓没有贡献，**不必解析**。超长工具输出就死在这里。
        if let Some(role) = fast_role(raw) {
            if role != "user" && role != "assistant" {
                continue;
            }
        }
        let text = String::from_utf8_lossy(raw);
        let Ok(entry) = serde_json::from_str::<Value>(&text) else {
            continue; // 坏行/半行：与 read_page 同样跳过
        };
        if entry.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = entry.get("message") else { continue };
        match message.get("role").and_then(Value::as_str) {
            Some("user") => turns.push(OutlineTurn {
                turn: turns.len() + 1,
                start,
                end,
                prompt: excerpt(message),
                response: String::new(),
            }),
            Some("assistant") => {
                if let Some(last) = turns.last_mut() {
                    if last.response.len() < EXCERPT_CAP {
                        let text = excerpt(message);
                        if !text.is_empty() {
                            if !last.response.is_empty() {
                                last.response.push(' ');
                            }
                            last.response.push_str(&text);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(Outline { turns, total_bytes })
}

/// 去掉行首尾的 ASCII 空白（`\n` / `\r` / 空格 / 制表符），不碰内容。
fn trim_ascii(line: &[u8]) -> &[u8] {
    let is_ws = |b: &u8| matches!(b, b' ' | b'\t' | b'\r' | b'\n');
    let start = line.iter().position(|b| !is_ws(b)).unwrap_or(line.len());
    let end = line.iter().rposition(|b| !is_ws(b)).map(|i| i + 1).unwrap_or(start);
    &line[start..end]
}

/// 从一行 JSON 的**开头**读 `"role":"…"`，读不到返回 `None`。
///
/// **这是性能筛，不是正确性筛**：JSON 字符串里的引号一定是转义的（`\"`），
/// 所以行首这段字节里出现的 `"role":"` 只可能来自结构本身，不可能来自某条消息的正文
/// ——既不会把工具输出里的 `"role":"user"` 误当成真消息，也不会漏掉真消息
/// （前缀里读不到 role 时返回 `None`，调用方照常整行解析）。
///
/// @param line - 原始行字节
/// @returns role 字面量（`user` / `assistant` / `toolResult` / …），或 `None`
fn fast_role(line: &[u8]) -> Option<&str> {
    const NEEDLE: &[u8] = b"\"role\":\"";
    let head = &line[..line.len().min(ROLE_HEAD)];
    let at = head.windows(NEEDLE.len()).position(|w| w == NEEDLE)? + NEEDLE.len();
    let rest = &head[at..];
    let len = rest.iter().position(|b| *b == b'"')?;
    std::str::from_utf8(&rest[..len]).ok()
}

/// 取一条消息的正文（text 块拼接），按 {@link EXCERPT_CAP} 截断。
fn excerpt(message: &Value) -> String {
    let content = message.get("content");
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut out = String::new();
            for b in blocks {
                if b.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let Some(t) = b.get("text").and_then(Value::as_str) else { continue };
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(t);
                if out.chars().count() >= EXCERPT_CAP {
                    break;
                }
            }
            out
        }
        _ => String::new(),
    };
    if text.chars().count() <= EXCERPT_CAP {
        return text;
    }
    text.chars().take(EXCERPT_CAP).collect()
}

/* ────────────────────────── 条目 → 转录行 ────────────────────────── */

/// 一条 durable 条目投影成转录行；不属于转录的条目返回 `None`。
///
/// @param entry - 解析后的条目
/// @param offset - 该条目在文件里的起始字节偏移
fn row_of(entry: &Value, offset: u64) -> Option<Row> {
    match entry.get("type").and_then(Value::as_str)? {
        "message" => {
            let message = entry.get("message")?;
            let role = message.get("role").and_then(Value::as_str)?;
            if !matches!(role, "user" | "assistant" | "toolResult" | "bashExecution") {
                return None; // system / custom：转录里没有它们的位置（见模块头注释）
            }
            Some(Row {
                role: role.to_string(),
                message: message.clone(),
                offset,
            })
        }
        "compaction" => Some(compaction_row(entry, offset)),
        _ => None,
    }
}

/// 压缩条目 → 转录里的一行（DSH 对话里的「上下文已压缩」）。
///
/// 形状按 `message` 统一（前端只认 `role` + `message`）：
/// `{ role: "compaction", summary, tokensBefore, timestamp }`。
fn compaction_row(entry: &Value, offset: u64) -> Row {
    Row {
        role: "compaction".to_string(),
        offset,
        message: json!({
            "role": "compaction",
            "summary": entry.get("summary").cloned().unwrap_or(Value::String(String::new())),
            "tokensBefore": entry.get("tokensBefore").cloned().unwrap_or(Value::Null),
            "timestamp": entry.get("timestamp").cloned().unwrap_or(Value::Null),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// 写一个会话文件：`msgs` 里每项是 `(role, 文本)`，`extra` 是插在中间的原始条目。
    fn write_session(lines: &[String]) -> (tempdir::TempDir, std::path::PathBuf) {
        let dir = tempdir::TempDir::new();
        let path = dir.path().join("s.jsonl");
        let mut f = File::create(&path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        (dir, path)
    }

    /// 极简 tempdir（不引外部依赖：项目里已有同款小工具，见 title.rs 的测试）
    mod tempdir {
        pub struct TempDir(std::path::PathBuf);
        impl TempDir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!("piggy-transcript-{}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&p).unwrap();
                TempDir(p)
            }
            pub fn path(&self) -> &std::path::Path {
                &self.0
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    fn header() -> String {
        r#"{"type":"session","version":"3","id":"sess-1","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/tmp/p"}"#.to_string()
    }

    /// 一条消息条目（parentId 由调用方串好）
    fn msg(id: &str, parent: &str, role: &str, text: &str) -> String {
        format!(
            r#"{{"type":"message","id":"{id}","parentId":{parent},"timestamp":"2026-09-23T00:00:0{}.000Z","message":{{"role":"{role}","content":[{text}],"timestamp":1}}}}"#,
            id.len() % 10,
            text = format!(r#"{{"type":"text","text":"{text}"}}"#)
        )
    }

    fn text_row(r: &Row) -> String {
        r.message["content"][0]["text"].as_str().unwrap_or("").to_string()
    }

    #[test]
    fn page_from_tail_reads_backwards_and_reports_more() {
        // 120 条消息串成一条链
        let mut lines = vec![header(), r#"{"type":"model_change","id":"m1","parentId":null,"provider":"p","modelId":"x"}"#.to_string()];
        let mut parent = "m1".to_string();
        for i in 0..120 {
            let id = format!("id{i:03}");
            lines.push(msg(&id, &format!("\"{parent}\""), "user", &format!("第 {i} 条")));
            parent = id;
        }
        let (_d, path) = write_session(&lines);

        let page = read_page(&path, None, 50).unwrap();
        assert_eq!(page.rows.len(), 50);
        assert!(page.has_more);
        assert!(!page.branchy);
        // 最后一页的最后一行 = 文件里最后一条消息（贴底渲染的就是它）
        assert_eq!(text_row(page.rows.last().unwrap()), "第 119 条");
        assert_eq!(text_row(page.rows.first().unwrap()), "第 70 条");

        // 往上一页：接着游标读，正好接上、不重不漏
        let older = read_page(&path, Some(page.start_offset), 50).unwrap();
        assert_eq!(older.rows.len(), 50);
        assert_eq!(text_row(older.rows.last().unwrap()), "第 69 条");
        assert_eq!(text_row(older.rows.first().unwrap()), "第 20 条");

        // 最后一页：只有 20 条，且 has_more 转 false（到文件头了）
        let oldest = read_page(&path, Some(older.start_offset), 50).unwrap();
        assert_eq!(oldest.rows.len(), 20);
        assert!(!oldest.has_more, "读到文件头后不该再说还有更多");
        assert_eq!(text_row(oldest.rows.first().unwrap()), "第 0 条");
    }

    #[test]
    fn system_and_non_message_entries_do_not_take_page_slots() {
        // 一页 3 条：中间塞 system / model_change / custom，都不能占额度
        let lines = vec![
            header(),
            r#"{"type":"model_change","id":"m1","parentId":null,"provider":"p","modelId":"x"}"#.to_string(),
            msg("a", "\"m1\"", "system", "系统提示"),
            msg("b", "\"a\"", "user", "问题"),
            msg("c", "\"b\"", "assistant", "回答"),
            r#"{"type":"custom","id":"d","parentId":"c","customType":"web-search-results","data":{}}"#.to_string(),
            msg("e", "\"d\"", "toolResult", "工具输出"),
        ];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 3).unwrap();
        assert_eq!(page.rows.len(), 3);
        assert_eq!(
            page.rows.iter().map(|r| r.role.as_str()).collect::<Vec<_>>(),
            vec!["user", "assistant", "toolResult"]
        );
        // 这一页**装满了**，而前面还有字节（header / model_change / system）→ 乐观地说"还有"。
        // 宁可多给一次"点了没反应"的机会，也不能漏掉真实存在的历史。
        assert!(page.has_more);
        // 真去翻那一页：没有可显示的行，于是 has_more 转 false，按钮自己消失（不会无限点下去）
        let older = read_page(&path, Some(page.start_offset), 3).unwrap();
        assert!(older.rows.is_empty());
        assert!(!older.has_more);
    }

    #[test]
    fn compaction_entry_becomes_a_transcript_row() {
        let lines = vec![
            header(),
            msg("a", "null", "user", "问题"),
            r#"{"type":"compaction","id":"c1","parentId":"a","summary":"前面聊了天气","firstKeptEntryId":"a","tokensBefore":12345}"#.to_string(),
        ];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 10).unwrap();
        assert_eq!(page.rows.len(), 2);
        let row = &page.rows[1];
        assert_eq!(row.role, "compaction");
        assert_eq!(row.message["summary"], "前面聊了天气");
        assert_eq!(row.message["tokensBefore"], 12345);
    }

    #[test]
    fn a_line_larger_than_the_chunk_is_read_whole() {
        // 3 MB 的一行远大于 64 KiB 的分块：反向扫描必须把它拼回来
        let big = "x".repeat(3 * 1024 * 1024);
        let lines = vec![
            header(),
            msg("a", "null", "user", "问题"),
            msg("b", "\"a\"", "toolResult", &big),
            msg("c", "\"b\"", "assistant", "回答"),
        ];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 2).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(text_row(&page.rows[0]), big);
        assert_eq!(text_row(&page.rows[1]), "回答");
        assert!(page.has_more);
    }

    #[test]
    fn a_fork_follows_the_active_branch_not_the_file_order() {
        // 分支文件：a → b → c 是旧分支；b → d 是后来切过去的新分支（id3 在 d 之后）
        let lines = vec![
            header(),
            msg("a", "null", "user", "共同祖先"),
            msg("b", "\"a\"", "assistant", "旧分支的回答"),
            msg("c", "\"b\"", "user", "旧分支的追问"),
            msg("d", "\"b\"", "assistant", "新分支的回答"),
            msg("e", "\"d\"", "user", "新分支的追问"),
        ];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 10).unwrap();
        assert!(page.branchy, "有分支时必须走慢路径");
        let texts: Vec<String> = page.rows.iter().map(text_row).collect();
        assert_eq!(texts, vec!["共同祖先", "旧分支的回答", "新分支的回答", "新分支的追问"]);
        assert!(!texts.contains(&"旧分支的追问".to_string()), "别的分支的内容不能混进来");
    }

    #[test]
    fn truncated_tail_line_is_skipped_not_fatal() {
        // pi 写到一半被杀：最后一行不是合法 JSON
        let mut lines = vec![header(), msg("a", "null", "user", "问题"), msg("b", "\"a\"", "assistant", "回答")];
        let (_d, path) = write_session(&lines);
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            write!(f, "{{\"type\":\"message\",\"id\":\"c\",\"paren").unwrap();
        }
        let page = read_page(&path, None, 10).unwrap();
        assert_eq!(page.rows.len(), 2);
        assert_eq!(text_row(&page.rows[1]), "回答");
        lines.clear();
    }

    #[test]
    fn outline_covers_every_turn_with_anchors_and_previews() {
        let mut lines = vec![header(), r#"{"type":"model_change","id":"m1","parentId":null,"provider":"p","modelId":"x"}"#.to_string()];
        let mut parent = "m1".to_string();
        for i in 1..=4 {
            let uid = format!("u{i}");
            let aid = format!("a{i}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            lines.push(format!(
                r#"{{"type":"message","id":"t{i}","parentId":"{aid}","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"工具输出 {i}"}}]}}}}"#
            ));
            parent = format!("t{i}");
        }
        let (_d, path) = write_session(&lines);
        let o = outline(&path).unwrap();
        assert_eq!(o.turns.len(), 4, "一轮一条轮廓（工具结果不算轮）");
        assert_eq!(o.total_bytes, std::fs::metadata(&path).unwrap().len());
        let first = &o.turns[0];
        assert_eq!(first.turn, 1);
        assert_eq!(first.prompt, "问题 1");
        assert_eq!(first.response, "回答 1");
        // 锚点必须**精确落在用户那条消息上**：`before = end` 取到的页要以它结尾
        let page = read_page(&path, Some(first.end), 1).unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].role, "user");
        assert_eq!(text_row(&page.rows[0]), "问题 1");
        // 轮的顺序与偏移都升序
        assert!(o.turns.windows(2).all(|w| w[0].start < w[1].start && w[0].turn + 1 == w[1].turn));
    }

    #[test]
    fn outline_ignores_a_tool_output_that_quotes_a_role() {
        // 工具输出里**原样出现** `"role":"user"` 这串字符（JSON 里是转义的）：
        // 预筛靠"未转义的引号只可能来自结构"来保证不被它骗到。
        let quoted = r#"see {\"role\":\"user\"} in the payload"#;
        let lines = vec![
            header(),
            msg("u1", "null", "user", "真正的问题"),
            msg("a1", "\"u1\"", "assistant", "真正的回答"),
            format!(
                r#"{{"type":"message","id":"t1","parentId":"a1","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"{quoted}"}}]}}}}"#
            ),
            msg("u2", "\"t1\"", "user", "第二个问题"),
            msg("a2", "\"u2\"", "assistant", "第二个回答"),
        ];
        let (_d, path) = write_session(&lines);
        let o = outline(&path).unwrap();
        assert_eq!(o.turns.len(), 2, "工具输出里的 role 字样不能凭空造出一轮");
        assert_eq!(o.turns[0].prompt, "真正的问题");
        assert_eq!(o.turns[0].response, "真正的回答");
        assert_eq!(o.turns[1].prompt, "第二个问题");
    }

    #[test]
    fn outline_returns_the_whole_session_even_when_only_a_page_is_read() {
        // 20 轮：轮廓给全部 20 条，而尾页只给 3 行 —— 这正是"预览全部、展示部分"
        let mut lines = vec![header()];
        let mut parent = "null".to_string();
        for i in 1..=20 {
            let uid = format!("u{i:02}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            parent = uid.clone();
            let aid = format!("a{i:02}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);
        let o = outline(&path).unwrap();
        let page = read_page(&path, None, 3).unwrap();
        assert_eq!(o.turns.len(), 20);
        assert_eq!(page.rows.len(), 3);
        // 20 轮 = 40 行；尾页 3 行 = [第 19 轮的回答, 第 20 轮的提问, 第 20 轮的回答]，
        // 于是"第一条落在窗口里的轮"是第 20 轮（下标 19）—— 前 19 轮就是未载入那一段。
        let page_start = page.start_offset;
        let loaded_from = o.turns.iter().position(|t| t.start >= page_start).unwrap();
        assert_eq!(loaded_from, 19, "轮廓要能算出哪些轮还没载入");
        assert_eq!(o.turns[loaded_from].turn, 20);
    }

    #[test]
    fn outline_caps_excerpt_length() {
        let big = "字".repeat(5000);
        let lines = vec![header(), msg("u1", "null", "user", &big)];
        let (_d, path) = write_session(&lines);
        let o = outline(&path).unwrap();
        assert_eq!(o.turns[0].prompt.chars().count(), EXCERPT_CAP);
    }

    #[test]
    fn tail_page_has_no_newer_but_a_repage_window_does() {
        let mut lines = vec![header()];
        let mut parent = "null".to_string();
        for i in 1..=6 {
            let uid = format!("u{i}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            let aid = format!("a{i}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);

        let tail = read_page(&path, None, 4).unwrap();
        assert!(!tail.has_newer, "尾部那一页后面没有更新的内容");
        assert!(tail.has_more);

        // 换窗（跳转）：以第 2 轮的口答边界为右界取一页 —— 前面还有、后面也还有。
        // 页大小取 2：第 2 轮之前只有 3 行可显示（u1 / a1 / u2），取满 2 行才说明"前面还有"。
        let o = outline(&path).unwrap();
        let mid = read_page(&path, Some(o.turns[1].end), 2).unwrap();
        assert!(mid.has_more, "第 2 轮之前还有内容");
        assert!(mid.has_newer, "第 2 轮之后还有内容 —— 界面要能回到最新");
        assert_eq!(text_row(mid.rows.last().unwrap()), "问题 2");
    }

    #[test]
    fn missing_file_is_an_error_with_the_path_in_it() {
        let e = read_page(std::path::Path::new("/nope/definitely-not-here.jsonl"), None, 10).unwrap_err();
        assert!(e.contains("definitely-not-here.jsonl"), "报错要带上是哪个文件：{e}");
    }

    #[test]
    fn limit_is_clamped() {
        let lines = vec![header(), msg("a", "null", "user", "问题")];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 0).unwrap();
        assert_eq!(page.rows.len(), 1, "limit=0 也要给一行，否则前端永远转圈");
    }

    #[test]
    fn empty_file_gives_an_empty_page() {
        let (_d, path) = write_session(&[]);
        let page = read_page(&path, None, 10).unwrap();
        assert!(page.rows.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.start_offset, 0);
    }

    #[test]
    fn crlf_lines_are_parsed_too() {
        // Windows 上手改/工具写入的会话文件可能是 CRLF
        let dir = tempdir::TempDir::new();
        let path = dir.path().join("crlf.jsonl");
        let mut f = File::create(&path).unwrap();
        write!(f, "{}\r\n", header()).unwrap();
        write!(f, "{}\r\n", msg("a", "null", "user", "问题")).unwrap();
        let page = read_page(&path, None, 10).unwrap();
        assert_eq!(page.rows.len(), 1);
        assert_eq!(text_row(&page.rows[0]), "问题");
    }

    /// 真机会话：`cargo test --lib -- --ignored real_machine_page` 才跑。
    ///
    /// 顺便量出"打开一页"与"读整个文件"的真实差距（这是分页的唯一理由，必须可复现）。
    #[test]
    #[ignore]
    fn real_machine_page() {
        let dir = crate::config::pi_files::sessions_root();
        let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
        collect_jsonl(&dir, &mut files);
        files.sort_by_key(|(sz, _)| std::cmp::Reverse(*sz));
        for (sz, p) in files.iter().take(3) {
            let t0 = std::time::Instant::now();
            let page = read_page(p, None, DEFAULT_LIMIT).unwrap();
            let page_us = t0.elapsed().as_micros();

            let t0o = std::time::Instant::now();
            let o = outline(p).unwrap();
            let outline_us = t0o.elapsed().as_micros();

            let t1 = std::time::Instant::now();
            let whole = std::fs::read_to_string(p).unwrap();
            // 公平对照：把整文件的每一行都当 JSON 解析（"一次性 hydrate 全部历史"要付的代价）
            let parsed_rows = whole
                .lines()
                .filter(|l| !l.trim().is_empty())
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .filter(|e| row_of(e, 0).is_some())
                .count();
            let whole_ms = t1.elapsed().as_millis();

            println!(
                "{} ({:.1} MB / {} 行) → 尾页 {} 行 {page_us}µs；整文件读+解析 {whole_ms}ms（{} 个可显示行）hasMore={} branchy={}",
                p.file_name().unwrap().to_string_lossy(),
                *sz as f64 / 1e6,
                whole.lines().count(),
                page.rows.len(),
                parsed_rows,
                page.has_more,
                page.branchy,
            );
            println!(
                "    轮廓：{} 轮 / {outline_us}µs（整文件 {} 字节，只有含正文的行被解析）",
                o.turns.len(),
                o.total_bytes,
            );
        }
    }

    #[cfg(test)]
    fn collect_jsonl(dir: &std::path::Path, out: &mut Vec<(u64, std::path::PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_jsonl(&p, out);
            } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
                out.push((sz, p));
            }
        }
    }
}
