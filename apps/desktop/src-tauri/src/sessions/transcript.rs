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

/// 每页**至少**多少行。50 行按 DSH 的估算行高（~88px）远超一屏，够贴底渲染。
pub const DEFAULT_LIMIT: usize = 50;
/// 每页最多允许请求多少条（挡住前端传入的离谱值）。
pub const MAX_LIMIT: usize = 500;
/// 每页至少要覆盖几轮（用户消息）。
///
/// **为什么按轮兜底**（2026-09-23 用户实测）：他那场会话是 30 轮 / 1028 步
/// （平均一轮 34 行），"一页 50 行"于是只装了 1 轮多 —— 界面上表现为
/// "打开会话只看得到一轮"，刻度梯上 28/30 条是"未载入"。
/// 用户读的是**轮**，不是行数，所以页的粒度也得按轮兜底。
pub const MIN_TURNS: usize = 5;
/// 一页最多读多少行（一轮可能有几百行，光按轮兜底会把页撑爆）。
pub const MAX_ROWS: usize = 300;
/// 一页最多读多少字节（真正的载荷闸门：真机上有的一行就有 3.35 MB）。
pub const MAX_BYTES: u64 = 1024 * 1024;
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
    /// 本页**读完位置**的字节偏移；把它当 `after` 传回来就是"再往下一页"（向下续页）
    pub end_offset: u64,
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
            "endOffset": self.end_offset,
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
            end_offset: end,
            has_more: fast.has_more,
            has_newer,
            branchy: false,
        });
    }
    // 窗口里出现分支：快路径的"文件序 = 分支序"前提不成立了，退回整文件追叶子。
    let mut page = branch_window(&mut file, end, limit)?;
    page.has_newer = has_newer;
    page.end_offset = end;
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
    let mut turns = 0usize; // 已收集到的用户消息数（= 轮数）

    // 收页的停止条件（按顺序判）：够了 / 到文件头 / 触到行的上限 / 触到字节的上限。
    // "够了" = 行数到 `limit` **且**轮数到 `MIN_TURNS`：只按行数会在工具密集的会话里
    // 一页只装一轮（用户实测 30 轮 / 1028 步），只按轮数又可能被一轮几百行撑爆。
    while pos > 0
        && (rows_rev.len() < limit || turns < MIN_TURNS)
        && rows_rev.len() < MAX_ROWS
        && end.saturating_sub(pos) < MAX_BYTES
    {
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
            // 注意：压缩行也会出现在这里，但只有 user 行算一轮
            if row.role == "user" {
                turns += 1;
            }
            rows_rev.push(row);
        }
    }

    rows_rev.reverse();
    // 停下来的原因是"够了/触到上限"还是"到文件头"——只有后者才没有更早的了
    let has_more = pos > 0;
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

/// **向下续页**：从 `after`（含）开始顺序读一页。
///
/// 为什么需要它（用户 2026-09-23 第四轮）：换窗（跳到很久以前的某一轮）之后，窗口下面还有
/// 更新的内容，而当时只有"加载更早"这一个方向 —— 往下滚到底就撞墙，只能点「回到最新」跳回去。
/// DSH 的分页是双向的（`repageHead` + 尾部区），这里补齐向下的那一半。
///
/// `after` 用上一页的 `end_offset`（**读完位置**），所以相邻两页既不重也不漏。
///
/// @param path - 会话 JSONL 文件
/// @param after - 起始字节偏移（含）；`0` = 从文件头开始
/// @param limit - 行数下限（另有一个轮数下限，见 [`MIN_TURNS`]）
/// @returns 一页转录（`rows` 按时间正序）
pub fn read_after(path: &Path, after: u64, limit: usize) -> Result<Page, String> {
    let mut file = File::open(path).map_err(|e| format!("{} 读取失败: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("{} 读取失败: {e}", path.display()))?
        .len();
    let start_at = after.min(len);
    file.seek(SeekFrom::Start(start_at))
        .map_err(|e| format!("读取失败: {e}"))?;

    let limit = limit.clamp(1, MAX_LIMIT);
    let mut reader = std::io::BufReader::with_capacity(CHUNK, file);
    let mut rows: Vec<Row> = Vec::new();
    let mut turns = 0usize;
    let mut pos = start_at;
    let mut end_offset = start_at;
    let mut buf: Vec<u8> = Vec::new();
    let mut chain_broken = false;
    // 向下读的链检查：**这一条的 parentId 应当等于上一条的 id**。
    // 方向与 `collect_back` 相反（那边是从新往旧走：上一条的 parentId == 这一条的 id），
    // 写反了会把每一行都判成"断链"、整页退回慢路径（第一版就是这么错的）。
    let mut prev_id: Option<String> = None;
    let mut first = true;

    let mut last_was_user = false;
    loop {
        // 收尾必须在**轮边界**上：最后收进来的若是一条 user 行，说明这一轮的回答还没读到，
        // 在此收页会让读者往下滚时看到"一个问题没有回答"（下一页才有）。
        if rows.len() >= limit && turns >= MIN_TURNS && !last_was_user {
            break;
        }
        if rows.len() >= MAX_ROWS || end_offset.saturating_sub(start_at) >= MAX_BYTES {
            break;
        }
        buf.clear();
        let n = std::io::BufRead::read_until(&mut reader, b'\n', &mut buf)
            .map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
            break; // 文件尾
        }
        let line_start = pos;
        pos += n as u64;
        end_offset = pos;

        let raw = trim_ascii(&buf);
        if raw.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(raw);
        let Ok(entry) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if entry.get("type").and_then(Value::as_str) == Some("session") {
            continue;
        }
        let parent = entry.get("parentId").and_then(Value::as_str).map(str::to_string);
        if !first && prev_id.as_deref() != parent.as_deref() {
            chain_broken = true;
            break;
        }
        first = false;
        prev_id = entry.get("id").and_then(Value::as_str).map(str::to_string);
        if let Some(row) = row_of(&entry, line_start) {
            last_was_user = row.role == "user";
            if last_was_user {
                turns += 1;
            }
            rows.push(row);
        } else {
            last_was_user = false;
        }
    }

    if chain_broken {
        // 向下读也会跨分支：退回整文件追活动分支，再取 `after` 之后的那一段。
        // `file` 已经被 BufReader 接管，用 `get_mut()` 借回来（它会 seek，读位置无所谓）。
        let visible = branch_visible(reader.get_mut())?
            .into_iter()
            .filter(|(offset, _)| *offset >= start_at);
        let mut picked: Vec<Row> = Vec::new();
        let mut picked_turns = 0usize;
        let mut picked_end = start_at;
        for (offset, row) in visible {
            if picked.len() >= MAX_ROWS {
                break;
            }
            if picked.len() >= limit && picked_turns >= MIN_TURNS {
                break;
            }
            if row.role == "user" {
                picked_turns += 1;
            }
            picked_end = offset + 1;
            picked.push(row);
        }
        return Ok(Page {
            rows: picked,
            start_offset: start_at,
            end_offset: picked_end,
            has_more: start_at > 0,
            has_newer: picked_end < len,
            branchy: true,
        });
    }

    Ok(Page {
        rows,
        start_offset: start_at,
        end_offset,
        has_more: start_at > 0,
        has_newer: end_offset < len,
        branchy: false,
    })
}

/// 整文件扫描 + 沿 parentId 追活动分支 → 按文件序返回可显示的行（含偏移）。
fn branch_visible(file: &mut File) -> Result<Vec<(u64, Row)>, String> {
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

    Ok(chain
        .into_iter()
        .filter_map(|i| row_of(&entries[i].1, entries[i].0).map(|row| (entries[i].0, row)))
        .collect())
}


/// 有分支时的兜底：整文件扫一遍，从最后一个条目沿 parentId 追到根，
/// 在这条链上取 `before` 之前的一页。
fn branch_window(file: &mut File, end: u64, limit: usize) -> Result<Page, String> {
    let visible: Vec<(u64, Row)> = branch_visible(file)?
        .into_iter()
        .filter(|(offset, _)| *offset < end)
        .collect();
    let take = visible.len().saturating_sub(limit);
    let window = &visible[take..];
    let rows: Vec<Row> = window.iter().map(|(_, r)| r.clone()).collect();
    let start_offset = window.first().map(|(o, _)| *o).unwrap_or(end);
    Ok(Page {
        has_more: take > 0,
        has_newer: false, // 由 read_page 按右边界填（这里无从判断）
        end_offset: end,
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
    // 把每轮的 `end` 从"用户那一行的结束"改成"**这一轮的结束**"（= 下一轮用户行的起点，
    // 最后一轮 = 文件尾）。跳转用它当右界，于是落地那一页正好以这一轮的**回答**收尾，
    // 而不是停在"刚问完、还没回答"的地方（第一版就是停在那儿，往下续页得先把回答读回来）。
    for i in 0..turns.len() {
        let next_start = turns.get(i + 1).map(|t| t.start).unwrap_or(total_bytes);
        turns[i].end = next_start;
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
        // 内容块先拼出来：`format!` 里再套 `format!` 会被 clippy 拦（`--all-targets`）
        let content = format!(r#"{{"type":"text","text":"{text}"}}"#);
        format!(
            r#"{{"type":"message","id":"{id}","parentId":{parent},"timestamp":"2026-09-23T00:00:0{}.000Z","message":{{"role":"{role}","content":[{content}],"timestamp":1}}}}"#,
            id.len() % 10,
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
        // 这一页只有 1 轮（< MIN_TURNS），于是继续往前读到文件头：
        // 前面那些条目一条都不进转录，has_more 因此**精确**为 false（不再"乐观地说还有"）。
        assert!(!page.has_more);
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
        // 锚点（`end`）= 这一轮内容的结束 = 下一轮用户行的起点：
        // `before = end` 取到的页要以**这一轮的回答**收尾（不是停在"刚问完"）
        let page = read_page(&path, Some(first.end), 1).unwrap();
        // 这一轮的内容 = 问题 + 回答 + 工具输出；锚点右边就是第 2 轮的提问
        assert_eq!(text_row(page.rows.last().unwrap()), "工具输出 1");
        assert_ne!(text_row(page.rows.last().unwrap()), "问题 2", "别把下一轮的提问读进来");
        // 往上一页的游标语义不变：`before = start` 之前就是上一轮的结束
        let older = read_page(&path, Some(first.start), 1).unwrap();
        assert!(older.rows.is_empty(), "第 1 轮之前什么都没有");
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
            let aid = format!("a{i:02}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);
        let o = outline(&path).unwrap();
        // 请求 3 行，但页会按轮兜底到 MIN_TURNS：最后 5 轮（u16..a20）= 10 行
        let page = read_page(&path, None, 3).unwrap();
        assert_eq!(o.turns.len(), 20);
        assert_eq!(page.rows.len(), MIN_TURNS * 2);
        assert_eq!(text_row(page.rows.first().unwrap()), "问题 16");
        // 于是"第一条落在窗口里的轮"是第 16 轮（下标 15）—— 前 15 轮就是未载入那一段。
        // 这正是"预览全部（20 轮）、只载入一部分（5 轮）"。
        let page_start = page.start_offset;
        let loaded_from = o.turns.iter().position(|t| t.start >= page_start).unwrap();
        assert_eq!(loaded_from, 15, "轮廓要能算出哪些轮还没载入");
        assert_eq!(o.turns[loaded_from].turn, 16);
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
        for i in 1..=12 {
            let uid = format!("u{i}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            let aid = format!("a{i}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);

        // 尾页：12 轮里取最后 5 轮（MIN_TURNS）= 10 行，前面还有 7 轮
        let tail = read_page(&path, None, 4).unwrap();
        assert!(!tail.has_newer, "尾部那一页后面没有更新的内容");
        assert!(tail.has_more);

        // 换窗（跳转）：以第 6 轮的口答边界为右界取一页 —— 前面还有、后面也还有。
        // （第 2 轮太靠前了：按轮兜底会一路读到文件头，has_more 自然为 false。）
        let o = outline(&path).unwrap();
        let mid = read_page(&path, Some(o.turns[5].end), 2).unwrap();
        assert!(mid.has_more, "第 6 轮之前还有内容");
        assert!(mid.has_newer, "第 6 轮之后还有内容 —— 界面要能回到最新");
        assert_eq!(text_row(mid.rows.last().unwrap()), "回答 6", "换窗那一页以这一轮的回答收尾");
    }

    #[test]
    fn a_page_covers_at_least_min_turns_even_for_tool_heavy_sessions() {
        // 用户实测的形状：一轮 = 1 条 user + 1 条 assistant + 12 条 toolResult（14 行）。
        // ⚠️ toolResult 必须**串成一条链**（父节点是上一条），全挂同一个父节点就成了分支，
        //    会被链检查识别出来走慢路径（第一版夹具就是这么写错的，量到 24 行还以为是分页坏了）。
        let mut lines = vec![header()];
        let mut parent = "null".to_string();
        for i in 1..=8 {
            let uid = format!("u{i}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            let aid = format!("a{i}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid.clone();
            for k in 0..12 {
                let tid = format!("t{i}_{k}");
                lines.push(format!(
                    r#"{{"type":"message","id":"{tid}","parentId":"{parent}","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"输出 {i}-{k}"}}]}}}}"#
                ));
                parent = tid;
            }
        }
        let (_d, path) = write_session(&lines);

        // 只按 50 行取会得到 3 轮多（3×14=42 行 -> 第 4 轮半）—— 那正是"打开只看得到一轮多"的来源
        let page = read_page(&path, None, DEFAULT_LIMIT).unwrap();
        let users = page.rows.iter().filter(|r| r.role == "user").count();
        assert!(users >= MIN_TURNS, "工具密集的会话里，一页必须够 {MIN_TURNS} 轮，实际 {users}");
        assert!(page.rows.len() <= MAX_ROWS);
        assert!(page.has_more, "8 轮里只取了后几轮，前面还有");
        // 一轮 14 行：5 轮 = 70 行（> 行数下限 50，所以是"按轮兜底"撑到这里的）
        assert_eq!(page.rows.len(), 14 * MIN_TURNS);
        assert_eq!(text_row(page.rows.first().unwrap()), "问题 4");
    }

    #[test]
    fn a_page_stops_at_the_row_cap_when_one_turn_is_enormous() {
        // 一轮 400 行：按轮兜底会撑爆，必须被 MAX_ROWS 截住
        let mut lines = vec![header(), msg("u1", "null", "user", "唯一的提问")];
        let mut parent = "u1".to_string();
        for k in 0..400 {
            let tid = format!("t{k}");
            lines.push(format!(
                r#"{{"type":"message","id":"{tid}","parentId":"{parent}","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"输出 {k}"}}]}}}}"#
            ));
            parent = tid;
        }
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, DEFAULT_LIMIT).unwrap();
        assert_eq!(page.rows.len(), MAX_ROWS, "要被行数上限截住");
        assert!(page.has_more);
    }

    #[test]
    fn a_page_stops_at_the_byte_cap() {
        // 每行 ~200 KB：字节闸门（1 MiB）必须先于行数/轮数生效
        let big = "x".repeat(200 * 1024);
        let mut lines = vec![header(), msg("u1", "null", "user", "提问")];
        let mut parent = "u1".to_string();
        for k in 0..40 {
            let tid = format!("t{k}");
            lines.push(format!(
                r#"{{"type":"message","id":"{tid}","parentId":"{parent}","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"{big}"}}]}}}}"#
            ));
            parent = tid;
        }
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, DEFAULT_LIMIT).unwrap();
        assert!(page.rows.len() < 20, "一页读进来的字节要受闸门约束，实际 {} 行", page.rows.len());
        assert!(page.has_more);
    }

    #[test]
    fn forward_paging_continues_exactly_where_the_window_ended() {
        // 12 轮聊天：尾页（后 5 轮）→ 往下续页应当把剩下的补齐，且不重不漏
        let mut lines = vec![header()];
        let mut parent = "null".to_string();
        for i in 1..=12 {
            let uid = format!("u{i:02}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            let aid = format!("a{i:02}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);

        // 从文件头向下读：一条不落
        let first = read_after(&path, 0, 4).unwrap();
        assert_eq!(text_row(first.rows.first().unwrap()), "问题 1");
        // 4 行下限 + 5 轮下限，且在**轮边界**收尾：5 轮 = 10 行（u5 + a5 都要在）
        assert_eq!(first.rows.len(), 10);
        assert_eq!(text_row(first.rows.last().unwrap()), "回答 5");
        assert!(first.has_newer, "12 轮里只取了 5 轮，后面还有");
        assert!(!first.has_more, "从文件头开始，前面没有内容");

        // 尾部窗口 + 向下续页：拼起来正好等于整段（既不重也不漏）
        let tail = read_page(&path, None, 4).unwrap();
        assert!(tail.has_more, "尾部窗口前面还有");
        let after = read_after(&path, tail.end_offset, 4).unwrap();
        assert!(
            after.rows.is_empty(),
            "尾部窗口的 end_offset 就是文件尾，再往下应当什么都没有，实际 {} 行",
            after.rows.len()
        );
        assert!(!after.has_newer);
        assert!(after.has_more, "窗口起点之前仍然有内容（has_more 说的是这条）");

        // 中段窗口（换窗到第 3 轮）：往上、往下都能续
        let o = outline(&path).unwrap();
        let mid = read_page(&path, Some(o.turns[2].end), 4).unwrap();
        assert_eq!(text_row(mid.rows.last().unwrap()), "回答 3", "换窗那一页以这一轮的回答收尾");
        let down = read_after(&path, mid.end_offset, 4).unwrap();
        assert_eq!(text_row(down.rows.first().unwrap()), "问题 4", "向下续页要正好接上");
        // 从第 4 轮起，读到 5 轮边界：第 4~8 轮 = 10 行
        assert_eq!(down.rows.len(), 10);
        assert_eq!(text_row(down.rows.last().unwrap()), "回答 8");
        assert!(down.has_more, "向下这一页自己不算窗口起点，但窗口起点之前仍有内容");
    }

    #[test]
    fn forward_paging_respects_the_byte_cap() {
        let big = "x".repeat(200 * 1024);
        let mut lines = vec![header(), msg("u1", "null", "user", "提问")];
        let mut parent = "u1".to_string();
        for k in 0..40 {
            let tid = format!("t{k}");
            lines.push(format!(
                r#"{{"type":"message","id":"{tid}","parentId":"{parent}","message":{{"role":"toolResult","toolName":"read","content":[{{"type":"text","text":"{big}"}}]}}}}"#
            ));
            parent = tid;
        }
        let (_d, path) = write_session(&lines);
        let page = read_after(&path, 0, DEFAULT_LIMIT).unwrap();
        assert!(page.rows.len() < 20, "向下读也要受字节闸门约束，实际 {} 行", page.rows.len());
        assert!(page.has_newer);
    }

    /// 命令接线：`session_page` 必须把 `after` 路由到 `read_after`。
    /// （单测 `read_after` 自己是绿的，但"命令有没有接上"是另一个事实 —— 缺了它，
    /// 界面点了「继续往下」也只会拿到"尾部/换窗"那一页。）
    #[tokio::test]
    async fn session_page_command_routes_after_to_forward_paging() {
        let mut lines = vec![header()];
        let mut parent = "null".to_string();
        for i in 1..=12 {
            let uid = format!("u{i:02}");
            lines.push(msg(&uid, &format!("\"{parent}\""), "user", &format!("问题 {i}")));
            let aid = format!("a{i:02}");
            lines.push(msg(&aid, &format!("\"{uid}\""), "assistant", &format!("回答 {i}")));
            parent = aid;
        }
        let (_d, path) = write_session(&lines);
        let p = path.to_string_lossy().to_string();

        // 向下续页：`after = 0` 从文件头读，页大小 4（12 轮里只取前 5 轮 → 后面还有）
        let page = crate::commands::session_page(p.clone(), None, Some(0), Some(4))
            .await
            .unwrap();
        assert_eq!(page["rows"][0]["message"]["content"][0]["text"], "问题 1");
        assert!(page["hasNewer"].as_bool().unwrap());

        // 尾部那一页：不带 after
        let tail = crate::commands::session_page(p.clone(), None, None, Some(4))
            .await
            .unwrap();
        assert_eq!(tail["hasNewer"], false);
        assert!(tail["endOffset"].as_u64().unwrap() > 0);

        // 换窗：带 before
        let o = outline(&path).unwrap();
        let mid = crate::commands::session_page(p, Some(o.turns[5].end), None, Some(4))
            .await
            .unwrap();
        assert_eq!(
            mid["rows"].as_array().unwrap().last().unwrap()["role"],
            "assistant",
            "换窗那一页要以这一轮的回答收尾"
        );
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
