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
/// 读 `id` / `parentId` 时的**尾部**回退窗口：pi 有一类条目把它们写在载荷之后
/// （实测 `web-search-results`），只看行首会漏掉，于是链条判断出错。
const TAIL_WINDOW: usize = 512;


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
    Ok(branch_entries(file)?
        .into_iter()
        .filter_map(|(offset, entry)| row_of(&entry, offset).map(|row| (offset, row)))
        .collect())
}

/// 整文件扫描 + 沿 parentId 追活动分支 → **原始条目**（含 custom 条目），文件序。
///
/// 与 [`branch_visible`] 的区别只在最后一层：那个把条目映射成"可显示的行"
/// （custom 条目会被 `row_of` 丢掉），这个保留全部 —— todo 投影要读的正是
/// `todo/write` 这种**不进转录**的 custom 条目。
///
/// 成本：整文件解析（真机 11.7 MB 的会话约 90ms）。所以只在**确实有分支**时走这里；
/// 线性文件（常态）走上面那条便宜的顺序扫描，见 [`todo_projection`]。
fn branch_entries(file: &mut File) -> Result<Vec<(u64, Value)>, String> {
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

    Ok(chain.into_iter().map(|i| entries[i].clone()).collect())
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

/* ────────────────────── 会话里的任务清单投影（docs/03 §2.20） ────────────────────── */

/// 一条 todo。字段与 pi-todo / DSH 的 `TodoItem` **同形**（只有内容与三态，
/// 没有 id/priority —— 整表替换下条目不需要稳定身份，见 DSH `src/types.ts:14-24`）。
#[derive(Debug, Clone, PartialEq)]
pub struct TodoItem {
    pub content: String,
    /// `pending` / `in_progress` / `completed`（非法值在读取时就丢掉整条）
    pub status: String,
}

/// 会话的任务清单投影。
///
/// 这是 DSH `sessionProjections` 的 `todos` 单元的等价物
/// （`packages/todo/tool-todo/src/index.ts:134-145`）：**最新一次整表写入**就是当前计划，
/// `null` = 还没有过写入。**外加 DSH 的 turn/start 清空规则**：写入之后又开始了新的一轮
/// （用户发了新消息）→ 投影回 `null`（`cleared_by_turn = true` 说明是"被清空"而不是"没写过"）。
///
/// 两个来源，按优先级：
///   1. `todo/write` —— 插件写的 **custom 会话条目**（与 DSH 的事件同名同形）；
///   2. `todo_write` 的**工具调用参数** —— 兜底：兼容"只注册了工具、没写条目"的实现。
#[derive(Debug, Clone, PartialEq)]
pub struct TodoProjection {
    /// 当前计划（`None` = 没有 / 已被新一轮清空）
    pub todos: Option<Vec<TodoItem>>,
    /// 这条结论来自哪：`event`（custom 条目）/ `call`（工具调用参数）
    pub source: Option<String>,
    /// 那条写入在文件里的字节偏移（界面可以据此"跳到那一轮"）
    pub offset: Option<u64>,
    /// 写入之后又开始了新的一轮 —— 按 DSH 的规则清空
    pub cleared_by_turn: bool,
    /// 整段会话里见过几次整表写入
    pub writes: usize,
    /// 文件有分支（活动分支比全部条目短）
    pub branchy: bool,
    /// 链条走断了 —— 上面的结论是**按文件序**折出来的（退回行为），不是沿活动分支
    pub chain_broken: bool,
    /// 扫了多少字节（性能观测用；真机 11.7 MB 的会话见 --ignored real_machine_todo）
    pub scanned_bytes: u64,
    /// 真正解析了多少行（预筛省掉的那些不算）
    pub parsed_lines: usize,
}

impl TodoProjection {
    /// 转成前端要的 JSON（字段名与 `apps/desktop/src/lib/todo.ts` 对齐）。
    pub fn to_json(&self) -> Value {
        json!({
            "todos": self.todos.as_ref().map(|list| list
                .iter()
                .map(|t| json!({"content": t.content, "status": t.status}))
                .collect::<Vec<_>>()),
            "source": self.source,
            "offset": self.offset,
            "clearedByTurn": self.cleared_by_turn,
            "writes": self.writes,
            "branchy": self.branchy,
            "chainBroken": self.chain_broken,
            "scannedBytes": self.scanned_bytes,
            "parsedLines": self.parsed_lines,
        })
    }
}

/// 字节级子串查找（预筛用，不解析 JSON）。
///
/// 按首字节定位再比对，而不是在每个位置都比一次整个 needle：真机上最贵的几行是
/// 3.35 MB 的工具输出，逐位置比较会白白扫掉几百万次四字节比较。
fn has_bytes(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || hay.len() < needle.len() {
        return false;
    }
    let first = needle[0];
    let mut from = 0usize;
    while let Some(pos) = hay[from..].iter().position(|b| *b == first) {
        let at = from + pos;
        if at + needle.len() <= hay.len() && &hay[at..at + needle.len()] == needle {
            return true;
        }
        from = at + 1;
    }
    false
}

/// 取一行的**结构头部**：到第一个载荷键（`"message"` / `"data"` / `"details"`）为止。
///
/// 为什么需要它（真机踩到的）：pi 写条目时结构字段在前、载荷在后，但**不是所有条目都这样**
/// —— 实测 11.7 MB 那场会话里，`web-search-results` 这个 custom 条目写成
/// `{"type":"custom","customType":"web-search-results","data":{"id":"…","type":"search",…}}`：
/// 顶层的 `id`/`parentId` 不在前缀里，而载荷里的 `data.id` 长得一模一样。
/// 早先直接在前缀里找 `"id":"` 的实现因此把 `data.id` 当成了条目 id，
/// 于是"parentId 对不上"→ 整份文件被误判成**有分支** → 走整文件解析的慢路径
/// （真机实测 11.7 MB 要 400 ms，而线性快路径只要几十毫秒）。
///
/// 切掉载荷之后，这类条目在链条判断里被**跳过**（它本来也不在 pi 的 `by_id` 里，
/// 不参与 parentId 链），线性文件于是真的被判成线性。
fn struct_head(raw: &[u8]) -> &[u8] {
    let limit = raw.len().min(ROLE_HEAD);
    let head = &raw[..limit];
    let mut cut = head.len();
    for key in [&b"\"message\":"[..], &b"\"data\":"[..], &b"\"details\":"[..]] {
        if let Some(at) = head.windows(key.len()).position(|w| w == key) {
            cut = cut.min(at);
        }
    }
    &head[..cut]
}

/// 一行的链条身份：`(id, parentId)`。两者**要么都从同一个窗口取到，要么都不用**。
///
/// 两个窗口，按优先级：
///   1. **结构头部**（[`struct_head`]，到第一个载荷键为止）—— 绝大多数条目的形状；
///   2. **尾部窗口**（最后 [`TAIL_WINDOW`] 字节）—— pi 有一类条目（实测
///      `web-search-results`，52 KB 一行）把 `id`/`parentId` 写在载荷**之后**，
///      它们出现在最后 ~80 字节里，而载荷里的 `data.id` 在行首附近。
///
/// 为什么必须成对：载荷里出现一个 `"id"` 是常有的事（搜索结果、工具输出都可能有），
/// 但载荷里同时出现 `"id"` 与 `"parentId"` 且都落在最后 512 字节里则近乎不可能。
/// 只读到一半时**按没有处理** —— 这一行不参与链条，也就不会把链条带偏
/// （真机那条"整份线性会话被判成分支、慢路径 400 ms"的根因就是只读到了半个）。
///
/// ⚠️ `"parentId":null`（根条目）与"没有这个键"必须分开：前者是链条的**终点**，
/// 后者是"这一行不在链条上"。早先把两者都 `flatten()` 成 `None`，于是根条目被踢出
/// 链条 → 沿 parentId 走到根时报"父条目找不到" → 整份文件被误判成走断。
///
/// 残留风险（写清楚）：若某行载荷末尾恰好同时含这两个键，会被误当成结构字段，
/// 后果是链条某条边指向不存在的条目 —— 那时 [`todo_projection`] 会走
/// `chainBroken` 的退回路径，并在返回值里标明结论不可信，而不是静默给出错误的计划。
/// @returns `Some((id, parentId))` —— `parentId` 为 `None` 表示这条是**根**（显式 `null`）；
///          `None` 表示这一行没有可用的链条身份（不参与链条）
fn chain_ref(raw: &[u8]) -> Option<(String, Option<String>)> {
    let head = struct_head(raw);
    if let (Some(Some(id)), Some(parent)) = (scan_key(head, "id"), scan_key(head, "parentId")) {
        return Some((id.to_string(), parent.map(str::to_string)));
    }
    let tail_len = raw.len().min(TAIL_WINDOW);
    let tail = &raw[raw.len() - tail_len..];
    if let (Some(Some(id)), Some(parent)) = (scan_key(tail, "id"), scan_key(tail, "parentId")) {
        return Some((id.to_string(), parent.map(str::to_string)));
    }
    None
}

/// 在一个字节切片里读 `"key":"值"` / `"key":null`。
///
/// 取**最后一次**出现：尾部窗口里可能先撞上载荷的 `data.id`，而条目自己的字段写在
/// 载荷之后（真机 `web-search-results` 就是这么写的）—— 取最后一个才是结构字段。
fn scan_key<'a>(slice: &'a [u8], key: &str) -> Option<Option<&'a str>> {
    let needle = format!("\"{key}\":");
    let at = slice.windows(needle.len()).rposition(|w| w == needle.as_bytes())? + needle.len();
    let rest = &slice[at..];
    match rest.first() {
        Some(b'"') => {
            let body = &rest[1..];
            let end = body.iter().position(|b| *b == b'"')?;
            std::str::from_utf8(&body[..end]).ok().map(Some)
        }
        // `null`（根条目）
        Some(b'n') if rest.starts_with(b"null") => Some(None),
        // 认不出来的形状：当这一行没有该键
        _ => None,
    }
}

/// 从任意 JSON 里读清单（形状不对 → `None`，绝不猜）。
fn read_todo_items(value: &Value) -> Option<Vec<TodoItem>> {
    let arr = value.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let content = item.get("content")?.as_str()?.to_string();
        let status = item.get("status")?.as_str()?.to_string();
        if !matches!(status.as_str(), "pending" | "in_progress" | "completed") {
            return None;
        }
        out.push(TodoItem { content, status });
    }
    Some(out)
}

/// 一条条目对投影的贡献。
enum Fold {
    /// 整表写入（带上来源与来源优先级：事件 0 < 调用 1）
    Write(Vec<TodoItem>, u8),
    /// 新一轮开始（用户消息）
    TurnStart,
    None,
}

/// 判一条条目是不是"写入"或"新一轮"。
fn classify(entry: &Value) -> Fold {
    match entry.get("type").and_then(Value::as_str) {
        Some("custom") => {
            if entry.get("customType").and_then(Value::as_str) != Some("todo/write") {
                return Fold::None;
            }
            match entry.get("data").and_then(|d| d.get("todos")).and_then(read_todo_items) {
                Some(list) => Fold::Write(list, 0),
                None => Fold::None, // 形状不认识：宁可不认，也不要显示半份清单
            }
        }
        Some("message") => {
            let message = match entry.get("message") {
                Some(m) => m,
                None => return Fold::None,
            };
            match message.get("role").and_then(Value::as_str) {
                Some("user") => Fold::TurnStart,
                Some("assistant") => {
                    let Some(content) = message.get("content").and_then(Value::as_array) else {
                        return Fold::None;
                    };
                    let mut best: Option<Vec<TodoItem>> = None;
                    for block in content {
                        if block.get("type").and_then(Value::as_str) != Some("toolCall") {
                            continue;
                        }
                        if block.get("name").and_then(Value::as_str) != Some("todo_write") {
                            continue;
                        }
                        if let Some(list) = block
                            .get("arguments")
                            .and_then(|a| a.get("todos"))
                            .and_then(read_todo_items)
                        {
                            best = Some(list); // 同一条消息里多次调用：取最后一次
                        }
                    }
                    match best {
                        Some(list) => Fold::Write(list, 1),
                        None => Fold::None,
                    }
                }
                _ => Fold::None,
            }
        }
        _ => Fold::None,
    }
}

/// 把一串（文件序）条目折叠成投影。
///
/// 规则就是 DSH 的 last-write-wins：**最后一次整表写入赢**，`turn/start` 把它清掉。
/// 来源优先级不参与"谁赢"—— 文件序已经决定了先后（插件先让模型调用、
/// 执行时再追写 custom 条目，所以同一份清单的条目天然排在调用之后）。
/// 来源只用来告诉前端"这条结论是读条目得来的，还是从调用参数里刨出来的"。
fn fold_projection(entries: &[(u64, &Fold)]) -> (Option<Vec<TodoItem>>, Option<String>, Option<u64>, bool, usize) {
    let mut current: Option<(Vec<TodoItem>, u8, u64)> = None; // (清单, 来源, 偏移)
    let mut cleared = false;
    let mut writes = 0usize;
    for (offset, fold) in entries {
        match fold {
            Fold::Write(list, rank) => {
                writes += 1;
                current = Some((list.clone(), *rank, *offset));
                cleared = false;
            }
            Fold::TurnStart => {
                if current.is_some() {
                    cleared = true;
                }
            }
            Fold::None => {}
        }
    }
    match current {
        Some((list, rank, offset)) => {
            let source = if rank == 0 { "event" } else { "call" };
            if cleared {
                // 写过了，但之后又开了新一轮：按 DSH 的 turn/start 规则清空。
                // 偏移与来源照样给出 —— 界面要能说"这里曾经有过一份清单"。
                (None, Some(source.to_string()), Some(offset), true, writes)
            } else {
                (Some(list), Some(source.to_string()), Some(offset), false, writes)
            }
        }
        None => (None, None, None, false, writes),
    }
}

/// 扫一遍会话文件，产出 todo 投影。
///
/// ## 一趟扫、只解析候选行
///
/// 与 [`outline`] 同一族（整文件顺序扫一次），但预筛更狠：一行里既没有 `todo` 字样、
/// 又不是用户消息的行**完全不解析**。真机上那几行 3.35 MB 的工具输出就死在这一步 ——
/// 解析它们（哪怕只为读一个 `id`）是这里最贵的开销。
///
/// 链条身份（`id` / `parentId`）改由**字节级扫描**取得（[`chain_key`]），
/// 所以整份文件再也不需要"有分支就整文件解析"的慢路径。真机实测见
/// `--ignored real_machine_todo`。
///
/// ## 分支怎么处理（这是这一块最容易做错的地方）
///
/// 会话文件可以有分支（fork / 回退）。**被放弃的分支上可能有一份清单**，
/// 把它当成"当前计划"就是说了假话。做法：
///
///   1. 扫的过程中记下 `id → (偏移, parentId)`；
///   2. 叶子 = 最后一个有 id 的条目（pi 的 leafId 规则），沿 `parentId` 往根走；
///   3. 只有**落在活动分支上**的候选（写入 / 用户消息）参与折叠；
///   4. 链条走断（父条目找不到）或候选自己没有 id 时，**退回按文件序折叠**并把
///      `chainBroken` 标出来 —— 宁可给出"最新一次写入"，也不要给出半个历史。
///
/// @param path - 会话 JSONL 文件
/// @returns 投影（含来源、偏移、是否被新一轮清空、链条是否可信）
pub fn todo_projection(path: &Path) -> Result<TodoProjection, String> {
    let file = File::open(path).map_err(|e| format!("{} 读取失败: {e}", path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(CHUNK, file);

    /// 一条候选（写入或新一轮）在文件里的位置与它的链条身份。
    struct Candidate {
        offset: u64,
        id: Option<String>,
        fold: Fold,
    }

    let mut chain: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
    let mut id_order: Vec<String> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut offset = 0u64;
    let mut scanned_bytes = 0u64;
    let mut parsed_lines = 0usize;
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
        scanned_bytes += n as u64;

        let raw = trim_ascii(&line);
        if raw.is_empty() {
            continue;
        }
        // 会话头（`"type":"session"`）没有 parentId，不参与链条
        if has_bytes(raw, b"\"type\":\"session\"") {
            continue;
        }
        if let Some((id_value, parent)) = chain_ref(raw) {
            chain.insert(id_value.clone(), parent);
            id_order.push(id_value);
        }

        // 预筛一：工具结果 / bash 执行行**不可能**是候选（清单只出现在 custom 条目、
        // 用户消息、助手消息里）。真机上最贵的那几行正是 toolResult（3.35 MB），
        // 这里连字节搜索都不做 —— 与 `outline` 跳过它们的理由是同一个。
        let role = fast_role(raw);
        if matches!(role, Some("toolResult") | Some("bashExecution")) {
            continue;
        }
        // 预筛二：没有 todo 字样、又不是用户消息 → 不解析
        let has_todo = has_bytes(raw, b"todo");
        let is_user = role == Some("user");
        if !has_todo && !is_user {
            continue;
        }
        let text = String::from_utf8_lossy(raw);
        let Ok(entry) = serde_json::from_str::<Value>(&text) else {
            continue; // 坏行/半行：与 read_page 同样跳过
        };
        parsed_lines += 1;
        let fold = classify(&entry);
        if matches!(fold, Fold::None) {
            continue;
        }
        let candidate_id = chain_ref(raw).map(|(id, _)| id);
        candidates.push(Candidate { offset: start, id: candidate_id, fold });
    }

    // 活动分支：从叶子沿 parentId 走到根
    let mut on_chain: Option<std::collections::HashSet<String>> = None;
    let mut chain_broken = false;
    if let Some(leaf) = id_order.last() {
        let mut path = std::collections::HashSet::new();
        let mut cursor = Some(leaf.clone());
        let mut guard = 0usize;
        while let Some(current) = cursor {
            if !path.insert(current.clone()) {
                break; // 成环：坏文件
            }
            guard += 1;
            if guard > id_order.len() + 1 {
                break;
            }
            match chain.get(&current) {
                Some(Some(parent)) => cursor = Some(parent.clone()),
                Some(None) => cursor = None, // 到根
                None => {
                    chain_broken = true;
                    cursor = None;
                }
            }
        }
        on_chain = Some(path);
    }

    // 候选自身没有 id（形状可疑）时全盘退回文件序 —— 见函数头第 4 条
    if candidates.iter().any(|c| c.id.is_none()) {
        chain_broken = true;
  }

    let selected: Vec<(u64, &Fold)> = candidates
        .iter()
        .filter(|c| {
            if chain_broken {
                return true;
            }
            match (&on_chain, &c.id) {
                (Some(path), Some(id)) => path.contains(id),
                _ => true,
            }
        })
        .map(|c| (c.offset, &c.fold))
        .collect();

    let branchy = on_chain
        .as_ref()
        .map(|path| path.len() < id_order.len())
        .unwrap_or(false);

    let (todos, source, write_offset, cleared, writes) = fold_projection(&selected);
    Ok(TodoProjection {
        todos,
        source,
        offset: write_offset,
        cleared_by_turn: cleared,
        writes,
        branchy,
        chain_broken,
        scanned_bytes,
        parsed_lines,
    })
}

/// 去掉行首尾的 ASCII 空白（`\n` / `\r` / 空格 / 制表符），不碰内容。
fn trim_ascii(line: &[u8]) -> &[u8] {    let is_ws = |b: &u8| matches!(b, b' ' | b'\t' | b'\r' | b'\n');
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
/// 形状按 `message` 统一（前端只认 `role` + `message`）。用户 2026-09-23 反馈
/// "上下文压缩的轨迹无法看到细节"，核实后确实**只转出了 3 个字段**，
/// 而 pi 的 `CompactionEntry`（pi `docs/compaction.md` 的 "CompactionEntry Structure"）还有
/// 四样能回答"这次压缩到底做了什么"的东西：
///
/// | 字段 | 含义 |
/// |---|---|
/// | `firstKeptEntryId` | 保留边界：**从哪一条起原样保留**，之前的都被摘要取代 |
/// | `details` | 默认实现记录 `readFiles` / `modifiedFiles`（扩展可放任意 JSON） |
/// | `usage` | 生成摘要那次 LLM 调用的用量与花费 |
/// | `fromHook` | 摘要由扩展提供（而非 pi 自己生成） |
///
/// ⚠️ **绝不转 `systemMessage`**：那是压缩后的整份新系统提示词（真机一条 10 KB+），
/// 一页里带上它等于把刚省下的载荷又还回去。用测试钉住（见
/// `compaction_row_carries_details_but_never_the_system_message`）。
fn compaction_row(entry: &Value, offset: u64) -> Row {
    Row {
        role: "compaction".to_string(),
        offset,
        message: json!({
            "role": "compaction",
            "summary": entry.get("summary").cloned().unwrap_or(Value::String(String::new())),
            "tokensBefore": entry.get("tokensBefore").cloned().unwrap_or(Value::Null),
            "firstKeptEntryId": entry.get("firstKeptEntryId").cloned().unwrap_or(Value::Null),
            "details": entry.get("details").cloned().unwrap_or(Value::Null),
            "usage": entry.get("usage").cloned().unwrap_or(Value::Null),
            "fromHook": entry.get("fromHook").cloned().unwrap_or(Value::Bool(false)),
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

    /// 压缩行要带**细节**（用户 2026-09-23："上下文压缩的轨迹无法看到细节"），
    /// 但绝不能带上 `systemMessage`——那是压缩后的整份新系统提示词。
    /// 夹具按真机形状写（`2026-09-21T14-18-43-680Z_01a0c455…jsonl` 里那条压缩条目
    /// 有 summary / firstKeptEntryId / tokensBefore / usage / details / fromHook / systemMessage）。
    #[test]
    fn compaction_row_carries_details_but_never_the_system_message() {
        // 故意让 systemMessage 很大：漏转的话这一页的载荷会立刻膨胀
        let huge_system = "系".repeat(20_000);
        // 注意 `r###"…"###`：正文里有 `"## Goal`，`r#"` 与 `r##"` 都会被那个引号加井号提前结束
        let entry = format!(
            r###"{{"type":"compaction","id":"c9","parentId":"a","timestamp":"2026-09-22T16:59:27.763Z","summary":"## Goal\n构建 Piggy","firstKeptEntryId":"86e95bf3","tokensBefore":561660,"usage":{{"input":475045,"output":3494,"totalTokens":478539,"cost":{{"total":0.1234}}}},"details":{{"readFiles":["docs/03.md","docs/04.md"],"modifiedFiles":["apps/desktop/src/lib/tokenFormat.ts"]}},"fromHook":false,"systemMessage":{{"role":"system","content":"{huge_system}"}}}}"###
        );
        let lines = vec![header(), msg("a", "null", "user", "问题"), entry];
        let (_d, path) = write_session(&lines);
        let page = read_page(&path, None, 10).unwrap();
        let row = &page.rows[1];
        let m = &row.message;

        assert_eq!(m["summary"], "## Goal\n构建 Piggy");
        assert_eq!(m["tokensBefore"], 561_660);
        assert_eq!(m["firstKeptEntryId"], "86e95bf3");
        assert_eq!(m["usage"]["totalTokens"], 478_539);
        assert_eq!(m["usage"]["cost"]["total"], 0.1234);
        assert_eq!(m["details"]["readFiles"][0], "docs/03.md");
        assert_eq!(m["details"]["modifiedFiles"][0], "apps/desktop/src/lib/tokenFormat.ts");
        assert_eq!(m["fromHook"], false);
        assert!(m.get("systemMessage").is_none(), "systemMessage 不许进转录行");
        // 这一行的 JSON 里也不该出现那 2 万个字（漏转就会露出来）
        assert!(!row.message.to_string().contains("系系系"));
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

    /* ────────────────── todo 投影（docs/03 §2.20） ────────────────── */

    /// 造一个条目，**字节布局照抄 pi**：`{"type":…,"id":…,"parentId":…,"timestamp":…,"message":…}`。
    ///
    /// 为什么不用 `serde_json::Map` 直接序列化：那个默认按**字母序**输出，`parentId`
    /// 会被排到 `message` 之后（大消息一撑就出 256 字节前缀）—— 于是这个 fixture 会
    /// 让"结构字段在行首"的前提失效，测出来的结论对真机不成立。真机 pi 写的顺序是
    /// 结构字段在前（1070 行实测，见模块头的性能注释），这里照着写。
    fn entry(id: &str, parent: Option<&str>, body: serde_json::Map<String, Value>) -> String {
        let ty = body.get("type").cloned().unwrap_or(json!("message"));
        let parent_json = match parent {
            Some(p) => json!(p),
            None => Value::Null,
        };
        let mut parts = vec![
            format!("\"type\":{ty}"),
            format!("\"id\":{}", json!(id)),
            format!("\"parentId\":{parent_json}"),
            "\"timestamp\":\"2026-01-01T00:00:00.000Z\"".to_string(),
        ];
        for (k, v) in &body {
            if k == "type" {
                continue;
            }
            parts.push(format!("{}:{v}", json!(k)));
        }
        format!("{{{}}}", parts.join(","))
    }

    /// 用户消息
    fn user(id: &str, parent: Option<&str>, text: &str) -> String {
        let mut b = serde_json::Map::new();
        b.insert("type".into(), json!("message"));
        b.insert(
            "message".into(),
            json!({"role": "user", "content": [{"type": "text", "text": text}]}),
        );
        entry(id, parent, b)
    }

    /// 助手消息里的一次 `todo_write` 调用
    fn call(id: &str, parent: Option<&str>, todos: Value) -> String {
        let mut b = serde_json::Map::new();
        b.insert("type".into(), json!("message"));
        b.insert(
            "message".into(),
            json!({"role": "assistant", "content": [
                {"type": "toolCall", "id": "c1", "name": "todo_write", "arguments": {"todos": todos}}
            ]}),
        );
        entry(id, parent, b)
    }

    /// 插件追写的 `todo/write` custom 条目
    fn event(id: &str, parent: Option<&str>, todos: Value) -> String {
        let mut b = serde_json::Map::new();
        b.insert("type".into(), json!("custom"));
        b.insert("customType".into(), json!("todo/write"));
        b.insert("data".into(), json!({"todos": todos}));
        entry(id, parent, b)
    }

    /// 别的扩展写的 custom 条目（不该被认成 todo）
    fn other_custom(id: &str, parent: Option<&str>) -> String {
        let mut b = serde_json::Map::new();
        b.insert("type".into(), json!("custom"));
        b.insert("customType".into(), json!("pi-guardrails/observation"));
        b.insert("data".into(), json!({"note": "todo_write mentioned in a note"}));
        entry(id, parent, b)
    }

    /// 一段很长、带 todo 字样的工具输出（必须被预筛跳过，不解析）
    fn fat_tool_result(id: &str, parent: Option<&str>) -> String {
        let filler = "x".repeat(200_000);
        let mut b = serde_json::Map::new();
        b.insert("type".into(), json!("message"));
        b.insert(
            "message".into(),
            json!({"role": "toolResult", "toolName": "bash", "content": [
                {"type": "text", "text": format!("{filler} todo_write {filler}")}
            ]}),
        );
        entry(id, parent, b)
    }

    #[test]
    fn todo_projection_reads_the_last_write() {
        let lines = vec![
            user("u1", None, "做三件事"),
            call("a1", Some("u1"), json!([
                {"content": "一", "status": "in_progress"},
                {"content": "二", "status": "pending"},
                {"content": "三", "status": "pending"}
            ])),
            event("e1", Some("a1"), json!([
                {"content": "一", "status": "completed"},
                {"content": "二", "status": "in_progress"},
                {"content": "三", "status": "pending"}
            ])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        let todos = p.todos.expect("应有清单");
        assert_eq!(todos.len(), 3);
        assert_eq!(todos[1].status, "in_progress");
        assert_eq!(todos[0].status, "completed", "事件比调用参数新，应取事件");
        assert_eq!(p.source.as_deref(), Some("event"));
        assert_eq!(p.writes, 2, "一次调用 + 一次事件");
        assert!(!p.cleared_by_turn);
        assert!(!p.branchy);
        assert!(p.offset.is_some());
    }

    #[test]
    fn todo_projection_falls_back_to_the_tool_call_arguments() {
        let lines = vec![
            user("u1", None, "做两件事"),
            call("a1", Some("u1"), json!([
                {"content": "一", "status": "pending"},
                {"content": "二", "status": "pending"}
            ])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert_eq!(p.todos.unwrap().len(), 2);
        assert_eq!(p.source.as_deref(), Some("call"), "没有事件条目时应退回调用参数");
    }

    #[test]
    fn todo_projection_clears_when_a_new_turn_starts() {
        // DSH：`turn/start` → 投影回 null（`src/index.ts:140`）
        let lines = vec![
            user("u1", None, "第一件事"),
            event("e1", Some("u1"), json!([{"content": "一", "status": "completed"}])),
            user("u2", Some("e1"), "还有个新活儿"),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(p.todos.is_none(), "新一轮开始后不该再显示旧计划");
        assert!(p.cleared_by_turn, "要说清是『被新一轮清空』而不是『没写过』");
        assert_eq!(p.writes, 1);
        assert!(p.offset.is_some(), "清空也要留下『曾经写过』的位置");
    }

    #[test]
    fn todo_projection_stays_visible_while_the_turn_continues() {
        let lines = vec![
            user("u1", None, "第一件事"),
            event("e1", Some("u1"), json!([{"content": "一", "status": "in_progress"}])),
            event("e2", Some("e1"), json!([{"content": "一", "status": "completed"}])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert_eq!(p.todos.unwrap()[0].status, "completed");
        assert!(!p.cleared_by_turn);
        assert_eq!(p.writes, 2);
    }

    #[test]
    fn todo_projection_ignores_foreign_entries_and_malformed_lists() {
        let lines = vec![
            user("u1", None, "x"),
            other_custom("c1", Some("u1")),
            event("e1", Some("c1"), json!([{"content": "一", "status": "done"}])), // 非法状态
            event("e2", Some("e1"), json!("不是数组")),
            event("e3", Some("e2"), json!([{"content": "一"}])), // 缺 status
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(p.todos.is_none(), "形状不认识的清单宁可不显示");
        assert_eq!(p.writes, 0, "不认识的条目不算一次写入");
    }

    #[test]
    fn todo_projection_without_any_write_is_empty() {
        let lines = vec![user("u1", None, "普通对话"), call("a1", Some("u1"), json!([]))];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        // 空数组是一次合法的"清空"写入
        assert_eq!(p.todos.unwrap().len(), 0);
        assert_eq!(p.writes, 1);
    }

    #[test]
    fn todo_projection_skips_fat_tool_output_without_parsing_it() {
        let lines = vec![
            user("u1", None, "跑个命令"),
            fat_tool_result("t1", Some("u1")),
            event("e1", Some("t1"), json!([{"content": "一", "status": "pending"}])),
        ];
        let (_d, path) = write_session(&lines);
        let t0 = std::time::Instant::now();
        let p = todo_projection(&path).unwrap();
        let us = t0.elapsed().as_micros();
        assert_eq!(p.todos.unwrap().len(), 1);
        // 预筛必须真的生效：三段 200 KB 的正文只该解析 3 行（user / custom / 无）
        assert!(p.parsed_lines <= 3, "解析了 {} 行，预筛没生效", p.parsed_lines);
        assert!(p.scanned_bytes > 400_000);
        println!("todo 投影：{} 字节 / 解析 {} 行 / {us}µs", p.scanned_bytes, p.parsed_lines);
    }

    #[test]
    fn todo_projection_follows_the_active_branch_only() {
        // 分支场景：u1 → a1（旧分支上写了清单）→ u2（改写需求）→ a2（新分支，没有清单）
        // 叶子是 a2，所以活动分支是 u2/a2 —— **不该**看到 a1 上的清单。
        let lines = vec![
            user("u1", None, "第一版需求"),
            event("e1", Some("u1"), json!([{"content": "旧计划", "status": "pending"}])),
            user("u2", Some("u1"), "算了，改需求"),
            {
                let mut b = serde_json::Map::new();
                b.insert("type".into(), json!("message"));
                b.insert("message".into(), json!({"role": "assistant", "content": [{"type": "text", "text": "好"}]}));
                entry("a2", Some("u2"), b)
            },
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(p.branchy, "parentId 链断了 → 应走分支慢路径");
        assert!(p.todos.is_none(), "被放弃的分支上的清单不能当成当前计划");
        assert_eq!(p.writes, 0);
    }

    #[test]
    fn todo_projection_reads_the_branch_that_actually_has_the_list() {
        // 线性链（u1 → u2 → e1）：清单在链尾，应当读到；这条路径必须是便宜的那条
        let lines = vec![
            user("u1", None, "第一版需求"),
            user("u2", Some("u1"), "改需求"),
            event("e1", Some("u2"), json!([{"content": "新计划", "status": "pending"}])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(!p.branchy, "parentId 首尾相接的链就是线性文件，别走慢路径");
        assert_eq!(p.todos.unwrap()[0].content, "新计划");
    }

    /// 真机回归：`web-search-results` 这类**载荷在前**的 custom 条目。
    ///
    /// 它写成 `{"type":"custom","customType":"…","data":{"id":"…"}}`：顶层没有 `id`/`parentId`，
    /// 而载荷里的 `data.id` 与前缀扫描要找的 `"id":"` 长得一模一样。
    /// 早先的实现把它当成条目 id，于是 parentId 对不上 → 整份**线性**会话被误判成有分支
    /// → 走整文件解析的慢路径（真机 11.7 MB 实测 400 ms，快路径只要几十毫秒）。
    /// 这条用例把"线性就是线性"钉住。
    #[test]
    fn payload_first_entries_do_not_make_a_linear_file_look_branched() {
        // 真机形状：载荷里的 `data.id` 在前，条目自己的 id/parentId 在**最后**
        let payload_first = r#"{"type":"custom","customType":"web-search-results","data":{"id":"nested-id","type":"search","timestamp":1790003230702,"query":"x"},"id":"s1","parentId":"a1","timestamp":"2026-09-21T15:07:10.776Z"}"#.to_string();
        let lines = vec![
            user("u1", None, "查一下"),
            call("a1", Some("u1"), json!([
                {"content": "一", "status": "pending"},
                {"content": "二", "status": "pending"},
                {"content": "三", "status": "pending"}
            ])),
            payload_first, // 它在**链条中间**：e1 的 parent 就是它（真机 line 108 的形状）
            event("e1", Some("s1"), json!([
                {"content": "一", "status": "in_progress"},
                {"content": "二", "status": "pending"},
                {"content": "三", "status": "pending"}
            ])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(!p.branchy, "载荷在前的 custom 条目不该把线性会话判成分支（真机 400ms 慢路径的成因）");
        assert_eq!(p.todos.unwrap()[0].status, "in_progress");
        assert_eq!(p.writes, 2);
        assert_eq!(p.source.as_deref(), Some("event"));
    }

    /// 载荷里只有 `id`、没有 `parentId` → **按没有链条身份处理**（成对才认）。
    ///
    /// 载荷里出现单个 `"id"` 太常见（搜索结果、工具输出），认了它就会把链条带偏 ——
    /// 真机那次"线性会话被判成分支"正是这么来的。成对要求把它挡在门外。
    #[test]
    fn a_lone_payload_id_is_not_mistaken_for_the_entry_id() {
        let payload_only = r#"{"type":"custom","customType":"other","data":{"id":"nested-id","note":"x"}}"#.to_string();
        let lines = vec![
            user("u1", None, "x"),
            call("a1", Some("u1"), json!([
                {"content": "一", "status": "pending"},
                {"content": "二", "status": "pending"},
                {"content": "三", "status": "pending"}
            ])),
            payload_only,
            event("e1", Some("a1"), json!([
                {"content": "一", "status": "completed"},
                {"content": "二", "status": "pending"},
                {"content": "三", "status": "pending"}
            ])),
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(!p.branchy, "载荷里的单个 id 不该被当成条目 id");
        assert!(!p.chain_broken, "这一行干脆不参与链条，链条应当完好");
        assert_eq!(p.todos.unwrap()[0].status, "completed");
    }

    /// 链条**走断**（父条目找不到）：退回按文件序折叠，并把 `chainBroken` 标出来。
    ///
    /// 这条是"不静默说谎"的兜底：走断意味着我们无法判断哪条是活动分支，
    /// 于是给出"最新一次写入"（用户最后一次看到的计划），同时明确标注链条不可信 ——
    /// 界面/日志据此可以说清结论的强度。
    #[test]
    fn a_broken_chain_falls_back_to_file_order_and_says_so() {
        let dangling = r#"{"type":"message","id":"a2","parentId":"missing-id","message":{"role":"assistant","content":[{"type":"text","text":"好"}]}}"#.to_string();
        let lines = vec![
            user("u1", None, "x"),
            event("e1", Some("u1"), json!([{"content": "一", "status": "pending"}])),
            dangling,
        ];
        let (_d, path) = write_session(&lines);
        let p = todo_projection(&path).unwrap();
        assert!(p.chain_broken, "父条目找不到时应标出链条走断");
        assert_eq!(p.todos.map(|t| t.len()), Some(1), "退回文件序后应仍看得到那份清单");
    }

    #[test]
    fn todo_projection_survives_a_truncated_last_line() {
        let dir = tempdir::TempDir::new();
        let path = dir.path().join("half.jsonl");
        let mut f = File::create(&path).unwrap();
        writeln!(f, "{}", user("u1", None, "x")).unwrap();
        writeln!(f, "{}", event("e1", Some("u1"), json!([{"content": "一", "status": "pending"}]))).unwrap();
        write!(f, "{{\"type\":\"message\",\"id\":\"a1\",\"message\":{{\"role\":\"assis").unwrap();
        drop(f);
        let p = todo_projection(&path).unwrap();
        assert_eq!(p.todos.unwrap().len(), 1, "半行应被跳过，不影响前面的结论");
    }

    /// 真机（可选）：对着本机最大的几个会话文件跑一遍投影，看成本。
    /// `cargo test -- --ignored real_machine_todo`
    #[test]
    #[ignore]
    fn real_machine_todo() {
        // 指定单个文件（例如"我刚在某个项目里跑了一场真实会话，核一下投影对不对"）：
        //   PIGGY_TODO_SESSION=/path/to/s.jsonl cargo test --release --lib real_machine_todo -- --ignored --nocapture
        if let Ok(one) = std::env::var("PIGGY_TODO_SESSION") {
            let p = std::path::PathBuf::from(&one);
            let sz = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            let t0 = std::time::Instant::now();
            let proj = todo_projection(&p).unwrap();
            let us = t0.elapsed().as_micros();
            println!(
                "{} ({:.1} MB) → {us}µs：{} / 来源 {} / 写 {} 次 / 解析 {} 行 / branchy={} / chainBroken={}",
                p.file_name().unwrap().to_string_lossy(),
                sz as f64 / 1e6,
                match &proj.todos {
                    Some(list) => format!("{} 条：{}", list.len(), list.iter().map(|t| format!("[{}] {}", t.status, t.content)).collect::<Vec<_>>().join(" | ")),
                    None => "无".to_string(),
                },
                proj.source.clone().unwrap_or_else(|| "-".into()),
                proj.writes,
                proj.parsed_lines,
                proj.branchy,
                proj.chain_broken,
            );
            return;
        }
        let root = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".pi/agent/sessions");
        let mut files: Vec<(u64, std::path::PathBuf)> = Vec::new();
        collect_jsonl(&root, &mut files);
        files.sort_by_key(|f| std::cmp::Reverse(f.0));
        for (sz, p) in files.iter().take(3) {
            let t0 = std::time::Instant::now();
            let proj = todo_projection(p).unwrap();
            let us = t0.elapsed().as_micros();
            // 同一次运行里量一个**已有的**整文件投影做对照（轮廓是打开会话时本来就要付的成本）
            let t1 = std::time::Instant::now();
            let outline = outline(p).unwrap();
            let outline_us = t1.elapsed().as_micros();
            println!(
                "{} ({:.1} MB) → todo 投影 {us}µs：{} / 来源 {} / 写 {} 次 / 扫 {} 字节 / 解析 {} 行 / branchy={}",
                p.file_name().unwrap().to_string_lossy(),
                *sz as f64 / 1e6,
                match &proj.todos {
                    Some(list) => format!("{} 条", list.len()),
                    None => "无".to_string(),
                },
                proj.source.clone().unwrap_or_else(|| "-".into()),
                proj.writes,
                proj.scanned_bytes,
                proj.parsed_lines,
                proj.branchy,
            );
            println!(
                "    对照：轮次轮廓 {} 轮 / {outline_us}µs（同一份文件、同一次运行）",
                outline.turns.len(),
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
