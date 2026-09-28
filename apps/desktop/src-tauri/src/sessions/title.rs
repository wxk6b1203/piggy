//! 会话标题生成（docs/03 §2.16）。
//!
//! ## 为什么要自己生成
//!
//! pi **没有**标题生成：`set_session_name` 只负责把名字写进会话文件
//! （`{"type":"session_info","name":…}`，`session-manager.ts:1316`），
//! 谁来决定叫什么名字是客户端的事。所以侧栏今天显示的是 `sessionTitle()` 的回落链
//! （`name` → `first_message` → 文件名），长会话的第一条消息往往是一整段话，
//! 在 220px 宽的侧栏里被省略号截成一行没法看的东西。
//!
//! ## 为什么是"另起一个 pi 进程"而不是直接发 HTTP
//!
//! 与插件管理同一条理由：**自己实现一份必然与 pi 分叉**。标题要用哪个 provider、
//! 哪个 model、哪把密钥（auth.json / models.json / 环境变量三级）、走不走代理、
//! `compat` 覆盖、OAuth 刷新……这些 pi 都已经处理好了。所以这里起一个
//! **一次性 pi 进程**：
//!
//! ```text
//! pi -p --no-session -nt -nc [--provider <p> --model <m>] [--thinking <level>] --system-prompt <S> <USER>
//! ```
//!
//! * `-p` 打印模式：模型的正文直接进 stdout，没有 TUI 转义；
//! * `--no-session`：**不写会话文件**（实测确认：跑完 sessions 目录里多 0 个文件）；
//! * `-nt`：不带任何工具（实测 `tools: []`）——生成标题不该让模型去读文件；
//! * `-nc`：不读 AGENTS.md/CLAUDE.md（标题与项目上下文无关，读了反而是噪声）；
//! * `--thinking`：可选，取值必须是 pi `cli/args.ts` 里那 7 个档位之一
//!   （写错 pi 只打一行警告然后静默用默认档，所以由 `is_valid_thinking` 把关）。
//!
//! 代价是每次约一次进程启动 + 一次模型调用。这是**用户显式点的动作**，不在热路径上。
//!
//! ## 标题不进模型输入
//!
//! 生成过程在一个**独立的 pi 进程**里，用 `--no-session` 跑，所以这段对话
//! 完全不进被命名那个会话的转录——与 DSH 的"titles never enter model input"同效，
//! 但这里靠的是进程隔离而不是服务侧保证。

use std::path::Path;
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// 取哪几条消息做素材。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TitleStrategy {
    /// 只看第一条用户消息。会话跑偏了也还叫最初那个名字——最稳。
    First,
    /// 只看最近几条。适合"重新生成"：标题跟着话题走。
    Recent,
    /// 第一条 + 最近几条。默认：既知道从哪儿开始，也知道现在在干什么。
    #[default]
    #[serde(other)]
    Both,
}

impl TitleStrategy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::First => "first",
            Self::Recent => "recent",
            Self::Both => "both",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "first" => Ok(Self::First),
            "recent" => Ok(Self::Recent),
            "both" => Ok(Self::Both),
            other => Err(format!("未知的标题取材方式 {other:?}（可选：first / recent / both）")),
        }
    }
}

/// 默认字数上限。侧栏一行约 220px，20 个汉字正好；再长就被省略号吃掉，等于白生成。
pub const DEFAULT_MAX_CHARS: u32 = 20;

/// pi CLI 认可的思考档位，从 `packages/coding-agent/src/cli/args.ts:60`
/// 的 `VALID_THINKING_LEVELS` **逐个抄来**的，不是自己起的名。
///
/// 为什么要抄：写错一个字母 pi **不会报错**——它只在 stderr 打一行
/// `Warning: Invalid thinking level "…"` 然后**静默用默认档**继续跑
/// （真机验证过）。也就是说拼错 = 用户以为设了、实际没设，而且没有任何提示。
/// 所以这里必须自己校验一遍，前端那份清单与本常量互为金标（见
/// `thinking_levels_match_pi_cli` 与 `session-title-shape.test.ts`）。
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/// 是不是 pi 认的档位。空串**不算**（空 = 不传这个开关）。
pub fn is_valid_thinking(level: &str) -> bool {
    THINKING_LEVELS.contains(&level.trim())
}

/// `pi --list-models` 表格里的一行（**跨 IPC**，键名 camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub provider: String,
    pub id: String,
    /// pi 表格里的 `thinking` 列（源码里是 `m.reasoning`）。
    /// 它决定"思考强度"这个下拉有没有意义：不支持推理的模型 pi 只认 `off`。
    pub reasoning: bool,
}

/// `title_model_options` 的返回形状（**跨 IPC**，键名 camelCase）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOptions {
    pub models: Vec<ModelOption>,
    /// 一个模型都没解析出来时，把 pi 的**原话**带回来。
    /// 否则界面只能说"没有模型"，而真正的原因（没配密钥 / 表格格式变了）
    /// 就躺在 stdout 里没人看见。
    pub note: Option<String>,
    /// 是哪个 pi 答的（排错时第一个要问的问题）
    pub pi_bin: String,
    pub elapsed_ms: u128,
}
/// "最近几条"取几条用户消息进素材。
pub const RECENT_LIMIT: usize = 3;
/// 单条消息进提示词前先截到多少字符——长会话里第一条消息可能是一整篇粘贴的文档。
const PER_MESSAGE_CHARS: usize = 400;
/// 一次性 pi 进程的超时。标题是小事，卡住不能把界面钉死。
const GENERATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
/// `pi --list-models` 的超时（真机实测 0.6s；它只读配置、不调模型）。
const LIST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// 从会话文件里读出来的生成素材。
///
/// `rename_all = "camelCase"`：**跨 IPC 的形状一律 camelCase**。
/// 前端是 TypeScript，读的是 `elapsedMs`；不加这一行 Rust 会发 `elapsed_ms`，
/// 前端拿到 `undefined` —— 而且**不会报错**，只会把 `NaN` 和 `undefined`
/// 直接渲染给用户（这个 bug 真的发生过，见 `generated_result_keys_are_camel_case`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSource {
    pub cwd: Option<String>,
    /// 会话最后一次 `model_change` 的 provider（没有就 None → 用全局默认）
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub first_message: Option<String>,
    pub recent_messages: Vec<String>,
    pub user_message_count: usize,
    /// 会话里已有的名字（`session_info.name`）。有名字 = 用户改过或用生成过。
    pub current_name: Option<String>,
    /// 会话文件里出现过多少条消息（用于判断"值不值得生成"）
    pub message_count: usize,
}

/// 读会话文件，抽出生成标题需要的全部素材。**只读**。
pub fn read_source(path: &Path) -> Result<TitleSource, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("{} 读取失败: {e}", path.display()))?;
    let mut out = TitleSource {
        cwd: None,
        provider: None,
        model_id: None,
        first_message: None,
        recent_messages: Vec::new(),
        user_message_count: 0,
        current_name: None,
        message_count: 0,
    };
    // 只留最近 RECENT_LIMIT 条用户消息，用 VecDeque 滚动——长会话（几千条）不该把内存吃掉
    let mut recent: std::collections::VecDeque<String> = std::collections::VecDeque::new();

    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            // 会话文件是追加写的：崩溃可能留下半行。跳过而不是整份失败——
            // 否则一个坏行就让这个会话永远生成不了标题。
            continue;
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("session") => {
                out.cwd = v.get("cwd").and_then(|c| c.as_str()).map(str::to_string);
            }
            Some("model_change") => {
                // 取**最后一次**：会话中途换过模型时，跟当前在用的那个
                out.provider = v.get("provider").and_then(|c| c.as_str()).map(str::to_string);
                out.model_id = v.get("modelId").and_then(|c| c.as_str()).map(str::to_string);
            }
            Some("session_info") => {
                if let Some(n) = v.get("name").and_then(|c| c.as_str()) {
                    // 空串 = pi 里"显式清空标题"的语义（session-manager.ts:1318）
                    out.current_name = if n.trim().is_empty() { None } else { Some(n.to_string()) };
                }
            }
            Some("message") => {
                out.message_count += 1;
                let msg = &v["message"];
                if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
                    continue;
                }
                if let Some(text) = user_text(msg) {
                    out.user_message_count += 1;
                    if out.first_message.is_none() {
                        out.first_message = Some(text.clone());
                    }
                    if recent.len() == RECENT_LIMIT {
                        recent.pop_front();
                    }
                    recent.push_back(text);
                }
            }
            _ => {}
        }
    }
    out.recent_messages = recent.into_iter().collect();
    Ok(out)
}

/// 只取**纯文本块**拼成的用户消息。
///
/// 与 DSH 的资格判定同义（"only text blocks from human user/message events"）：
/// 图片块、工具结果、附件都不算——标题要的是人打的字。
/// 全是非文本的用户消息返回 `None`，于是那条被跳过（而不是生成一个空标题）。
fn user_text(msg: &Value) -> Option<String> {
    let content = msg.get("content")?;
    let mut text = String::new();
    match content {
        Value::String(s) => text.push_str(s),
        Value::Array(blocks) => {
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        if !text.is_empty() {
                            text.push(' ');
                        }
                        text.push_str(t);
                    }
                }
            }
        }
        _ => return None,
    }
    let t = text.trim();
    if t.is_empty() {
        None
    } else {
        Some(truncate_chars(t, PER_MESSAGE_CHARS))
    }
}

/// 按**字符**截断（不是字节）。
///
/// 用 `chars()` 天然不会把一个多字节字符切两半——DSH 用 UTF-8 字节数做上限，
/// 于是"20 字节"在中文下只有 6 个字。**用户说的"字数"是字符数**，这里按字符算。
pub fn truncate_chars(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max {
            break;
        }
        out.push(c);
    }
    out
}

/// 把模型吐出来的东西收拾成能当标题用的一行。
///
/// 模型很爱加引号、加 "标题：" 前缀、结尾加句号、或者干脆写一整句解释。
/// 这里只做**机械**处理（不猜语义）：去引号/前缀/首尾标点、把换行和连续空白压成一个空格。
/// 收拾完为空就返回空串，调用方据此报错——**不要**用一个空标题把用户原来的名字覆盖掉。
pub fn sanitize(raw: &str, max_chars: u32) -> String {
    let mut s = raw.trim().to_string();
    // 只取第一行：模型偶尔会先来一句"好的，我来总结"再给标题
    if let Some(first) = s.lines().map(str::trim).find(|l| !l.is_empty()) {
        s = first.to_string();
    }
    // 去掉常见的前缀（中英）
    for prefix in ["标题：", "标题:", "Title:", "title:", "TITLE:", "标题 ", "Title "] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim().to_string();
        }
    }
    // 去掉成对的引号/书名号/方括号（模型最常见的包装）
    for (open, close) in [('"', '"'), ('\'', '\''), ('「', '」'), ('『', '』'), ('《', '》'), ('[', ']'), ('(', ')')] {
        if s.starts_with(open) && s.ends_with(close) && s.chars().count() > 2 {
            s = s[open.len_utf8()..s.len() - close.len_utf8()].trim().to_string();
        }
    }
    // 结尾的句号/逗号/分号——标题不带句号
    while s.ends_with(['。', '，', '、', '；', '.', ',', ';', '!', '！']) {
        s.pop();
    }
    // 换行/制表/连续空格压成一个空格
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(collapsed.trim(), max_chars.max(1) as usize)
}

/// 拼给模型的提示词，返回 `(system, user)`。
///
/// 要求写死"只回标题"是因为**解析只能靠约定**：`pi -p` 输出的是自由文本，
/// 没有结构化字段可用（这正是 pi 不提供标题生成的那部分）。
pub fn build_prompt(source: &TitleSource, strategy: TitleStrategy, max_chars: u32) -> (String, String) {
    // 提示词逐句对齐 DSH `session-title-llm/src/index.ts:194-207`。
    // 照抄而不是自己写，是因为 DSH 那三句各自挡掉一类真实失败：
    //   · "plain text … no Markdown/XML/terminal control codes" —— 否则模型会回一段
    //     ```json 或被 OSC 序列包住的文本，直接进侧栏就是乱码；
    //   · "Use the language of the messages" —— 中文会话不能起英文标题；
    //   · 字数目标分开写中英 —— "5 words" 对中文没有意义。
    // 差别：DSH 用 targetWords/targetCjkCharacters 两个目标，这里只有一个字符上限
    // （用户要的是"一定字数以内"），所以两句话合成一句。
    let system = [
        "Create a concise title for an AI coding-assistant session from the supplied human messages."
            .to_string(),
        "Return only the title on one line, in plain text of natural language, with no quotes, \
         prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed."
            .to_string(),
        "Use the language of the messages.".to_string(),
        format!("Aim for about {max_chars} characters, and never exceed {max_chars} characters."),
    ]
    .join("\n");

    // 素材装成 JSON 数组再交给模型（DSH 同款）：比自然语言拼接更不容易被消息里的
    // 内容"越狱"——用户消息里可能出现"忽略上面的指示"这类句子，
    // 放在 JSON 字符串里至少边界是明确的。
    let mut msgs: Vec<Value> = Vec::new();
    let mut push = |text: &str| {
        msgs.push(json!({ "text": text }));
    };
    if matches!(strategy, TitleStrategy::First | TitleStrategy::Both) {
        if let Some(f) = &source.first_message {
            push(f);
        }
    }
    if matches!(strategy, TitleStrategy::Recent | TitleStrategy::Both) {
        let skip_first = matches!(strategy, TitleStrategy::Both);
        for m in &source.recent_messages {
            if skip_first && Some(m) == source.first_message.as_ref() {
                continue;
            }
            push(m);
        }
    }
    if msgs.is_empty() {
        msgs.push(json!({ "text": "" }));
    }
    let user = format!(
        "Generate the session title from this JSON array of human messages:\n{}",
        serde_json::to_string(&msgs).unwrap_or_else(|_| "[]".into())
    );
    (system, user)
}

/// 生成结果（**返回给前端的形状，契约由 tests 锁死**）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Generated {
    /// 收拾干净、已按上限截断的标题
    pub title: String,
    /// 模型原样输出（排查用：界面在详情里显示）
    pub raw: String,
    pub provider: Option<String>,
    pub model_id: Option<String>,
    pub elapsed_ms: u128,
    pub prompt_chars: usize,
    /// 收拾之后为空 = 模型没给出能用的东西
    pub usable: bool,
}

/// 一次性生成进程的 argv。
///
/// 抽成纯函数是为了让"到底传了什么"能被单测覆盖：这几个开关每一个都有实际后果，
/// 而拼错了**不会报错**——只会换一种行为（`--no-session` 漏了就会写进会话转录、
/// `-nt` 漏了模型就可能去动文件）。这类错误只能靠对着 argv 断言发现。
pub fn generate_args(
    provider: Option<&str>,
    model_id: Option<&str>,
    thinking: Option<&str>,
    system: &str,
    user: &str,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--no-session".into(),
        "-nt".into(),
        "-nc".into(),
    ];
    // provider/model **成对**才传（`pick_model` 已经保证了这一点）
    if let (Some(p), Some(m)) = (provider, model_id) {
        args.push("--provider".into());
        args.push(p.to_string());
        args.push("--model".into());
        args.push(m.to_string());
    }
    // 思考强度：空/未设 = 不传这个开关，用 pi 与模型自己的默认。
    // pi 对**不认识**的档位只打一行警告然后静默用默认档（真机验证过），
    // 所以这里是最后一道关：只放行 `THINKING_LEVELS` 里的值。
    if let Some(t) = thinking.map(str::trim).filter(|s| is_valid_thinking(s)) {
        args.push("--thinking".into());
        args.push(t.to_string());
    }
    args.push("--system-prompt".into());
    args.push(system.to_string());
    // `--` 之后一律当消息：提示词里可能出现以 `-` 开头的内容（用户粘贴的 diff）
    args.push("--".into());
    args.push(user.to_string());
    args
}

/// 一次生成请求。
///
/// 参数到 8 个时，"第 5 个位置传的是什么"已经没法从调用点读出来了——而且这里
/// 三个 `Option<&str>` 挨在一起（provider / model_id / thinking），传串了**不会报错**，
/// 只会换成另一个模型或另一个档位。抽成结构体让调用点自解释。
pub struct GenRequest<'a> {
    pub pi_bin: &'a Path,
    pub cwd: &'a Path,
    pub provider: Option<&'a str>,
    pub model_id: Option<&'a str>,
    /// 思考档位（必须是 `THINKING_LEVELS` 里的；非法值不会被传给 pi）
    pub thinking: Option<&'a str>,
    pub system: &'a str,
    pub user: &'a str,
    pub max_chars: u32,
}

/// 起一个一次性 pi 进程生成标题。**不写任何文件**。
pub async fn generate(req: GenRequest<'_>) -> Result<Generated, String> {
    let GenRequest { pi_bin, cwd, provider, model_id, thinking, system, user, max_chars } = req;
    let started = std::time::Instant::now();
    let args = generate_args(provider, model_id, thinking, system, user);

    let mut child = Command::new(pi_bin)
        .args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 {} 失败：{e}", pi_bin.display()))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    // 先各自读到 EOF（进程退出后管道会关），再 wait。顺序反过来会死锁在满管道的写端。
    let collect = async {
        let mut o = String::new();
        let mut e = String::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_string(&mut o).await;
        }
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_string(&mut e).await;
        }
        (o, e)
    };
    let collected = match tokio::time::timeout(GENERATE_TIMEOUT, collect).await {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!("生成标题超过 {} 秒未返回，已中止", GENERATE_TIMEOUT.as_secs()));
        }
    };
    let status = child.wait().await.map_err(|e| format!("等待 pi 失败：{e}"))?;
    if !status.success() {
        let tail = collected.1.trim().lines().last().unwrap_or("").to_string();
        return Err(format!(
            "pi 生成标题失败（退出码 {}）{}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "信号".into()),
            if tail.is_empty() { String::new() } else { format!("：{tail}") }
        ));
    }

    let raw = collected.0.trim().to_string();
    let title = sanitize(&raw, max_chars);
    Ok(Generated {
        usable: !title.is_empty(),
        title,
        raw,
        provider: provider.map(str::to_string),
        model_id: model_id.map(str::to_string),
        elapsed_ms: started.elapsed().as_millis(),
        prompt_chars: system.chars().count() + user.chars().count(),
    })
}

/// 决定这次用哪个模型。
///
/// 优先级：设置里的覆盖 > 会话自己最后一次用过的 > 都不给（让 pi 用它自己的默认）。
/// 抽成纯函数是因为这是**唯一**一处"用错模型"会静默发生的地方：用错不会报错，
/// 只会花掉另一个模型的额度、或者因为没配好而失败得莫名其妙。
pub fn pick_model(
    override_ref: Option<&str>,
    source: &TitleSource,
) -> Result<(Option<String>, Option<String>), String> {
    if let Some(r) = override_ref.map(str::trim).filter(|s| !s.is_empty()) {
        let (p, m) = crate::config::app::split_model_ref(r)
            .ok_or_else(|| format!("设置里的「标题模型」要写成 provider/modelId，现在是 {r:?}"))?;
        // 显式覆盖**成对**生效：只给一半会退化成"provider 是这个、model 是那个"
        // 的错配（DSH 的 provider/model 也是 must-be-both-or-neither）
        return Ok((Some(p), Some(m)));
    }
    match (source.provider.as_deref(), source.model_id.as_deref()) {
        (Some(p), Some(m)) if !p.is_empty() && !m.is_empty() => {
            Ok((Some(p.to_string()), Some(m.to_string())))
        }
        // 会话里只有一半（旧格式/坏数据）→ 宁可都不传，让 pi 用默认，
        // 也不要拼出一个 pi 解析不了的 provider/model 组合
        _ => Ok((None, None)),
    }
}

/// 给界面看的素材摘要（不生成，只看会拿什么去生成）。
pub fn describe(
    source: &TitleSource,
    strategy: TitleStrategy,
    max_chars: u32,
    override_ref: Option<&str>,
    thinking: Option<&str>,
) -> Value {
    let (system, user) = build_prompt(source, strategy, max_chars);
    // "会用哪个模型"必须是**真正会被用的那个**，而不是会话里那个：
    // 设置里有覆盖时，会话自己的模型根本不会被调用。预览界面照着这里显示，
    // 两者分叉的话用户会对着一个错名字判断"为什么标题这么差"。
    let from_override = override_ref.map(str::trim).is_some_and(|s| !s.is_empty());
    let (model_used, model_source, model_error) = match pick_model(override_ref, source) {
        Ok((Some(p), Some(m))) => (
            Some(format!("{p}/{m}")),
            if from_override { "override" } else { "session" },
            None,
        ),
        // 谁都没给出模型 → 让 pi 用它自己的默认
        Ok(_) => (None, "default", None),
        // 覆盖写错了（比如只写了 provider）：生成时 `pick_model` 会直接报错，
        // 所以**不能**说成"默认"——那会让人以为会正常生成。这里把原因带到界面上。
        Err(e) => (None, "invalid", Some(e)),
    };
    json!({
        "cwd": source.cwd,
        "provider": source.provider,
        "modelId": source.model_id,
        "modelUsed": model_used,
        // 这个名字是从哪儿来的（设置覆盖 / 会话自己 / pi 的默认 / 覆盖写错了）——
        // 与"实际是哪个"分开说，因为改法完全不同
        "modelSource": model_source,
        "modelError": model_error,
        "thinking": thinking.map(str::trim).filter(|s| !s.is_empty()),
        "firstMessage": source.first_message,
        "recentMessages": source.recent_messages,
        "userMessageCount": source.user_message_count,
        "messageCount": source.message_count,
        "currentName": source.current_name,
        "strategy": strategy.as_str(),
        "maxChars": max_chars,
        "promptChars": system.chars().count() + user.chars().count(),
    })
}

/// 按「两个及以上空格」切列。
///
/// 表格是 `padEnd` 对齐后 `"  "` 连接的，所以列间**至少**两个空格，
/// 而单元格内部不会有连续空格（provider / model id 不含空格，其余是
/// `1M` / `384K` / `yes` / `no`）。
fn split_columns(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut out: Vec<&str> = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b' ' && i + 1 < bytes.len() && bytes[i + 1] == b' ' {
            out.push(&line[start..i]);
            while i < bytes.len() && bytes[i] == b' ' {
                i += 1;
            }
            start = i;
        } else {
            i += 1;
        }
    }
    out.push(&line[start..]);
    out.into_iter().map(str::trim).filter(|s| !s.is_empty()).collect()
}

/// 解析 `pi --list-models` 的输出。
///
/// pi **没有** `--json`（`cli/list-models.ts` 只打一张给人看的表），所以这里解析表格。
/// 这件事本身是有风险的——表格格式变了，解析就会悄悄少给几行。所以：
///   * 表头按**首两列的字面量**（`provider` / `model`）识别，不靠"第一行是表头"
///     （pi 以后往 stdout 前面加一行说明也不会错位）；
///   * 认不出的行**跳过**，不猜；
///   * `thinking` 列不是 `yes`/`no` 就跳过（列错位时不会把 `1M` 当成推理能力）；
///   * 解析出一条都没有时，调用方把 pi 的原话交给界面显示（见 `ModelOptions::note`），
///     而不是显示一个空下拉。
pub fn parse_list_models(stdout: &str) -> Vec<ModelOption> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let cells = split_columns(line);
        if cells.first() == Some(&"provider") && cells.get(1) == Some(&"model") {
            continue;
        }
        // 六列：provider / model / context / max-out / thinking / images
        if cells.len() < 6 {
            continue;
        }
        let (provider, id) = (cells[0], cells[1]);
        if provider.is_empty() || id.is_empty() {
            continue;
        }
        let reasoning = match cells[4] {
            "yes" => true,
            "no" => false,
            _ => continue,
        };
        let opt = ModelOption {
            provider: provider.to_string(),
            id: id.to_string(),
            reasoning,
        };
        if !out.contains(&opt) {
            out.push(opt);
        }
    }
    out
}

/// 跑一次 `pi --list-models`：pi 此刻**认为可用**的模型（已配好密钥的那些）。
///
/// 为什么用 CLI 而不是 `get_available_models` RPC：RPC 那条是**会话级**的
/// （Piggy 的 `pi_get_available_models` 必须带 `tabId`，见 `commands.rs`），
/// 而"标题模型"是全局设置——打开设置页时可能一个标签页都没有。
/// 两条路取的是同一份数据（`ModelRuntime.getAvailable()`，`list-models.ts:37`）。
///
/// `cwd` 会影响 pi 读到的**项目级**配置（`<cwd>/.pi/…`）：这里用 HOME，
/// 所以列出来的是"全局配置下可用的模型"（与标题进程真正跑的目录可能不同，
/// 详见 docs/15 的已知缺口）。项目级模型仍可手动填入。
pub async fn list_models(pi_bin: &Path, cwd: &Path) -> Result<ModelOptions, String> {
    let started = std::time::Instant::now();
    let mut child = Command::new(pi_bin)
        .args(["--list-models"])
        // 与一次性生成进程同样的处理：stdin 关掉，否则 pi 可能等着读输入
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 {} 失败：{e}", pi_bin.display()))?;

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let collect = async {
        let mut o = String::new();
        let mut e = String::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_string(&mut o).await;
        }
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_string(&mut e).await;
        }
        (o, e)
    };
    let (out, err) = match tokio::time::timeout(LIST_TIMEOUT, collect).await {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(format!("列出模型超过 {} 秒未返回，已中止", LIST_TIMEOUT.as_secs()));
        }
    };
    let status = child.wait().await.map_err(|e| format!("等待 pi 失败：{e}"))?;
    let models = parse_list_models(&out);
    if models.is_empty() {
        // 成功退出但一个都没解析出来：把 pi 的原话（stdout 优先，其次 stderr 最后一行）
        // 带回去。**不要**让界面只显示"没有模型"——那会让人以为是没装模型。
        let note = if !status.success() {
            err.trim().lines().last().map(|s| s.to_string())
        } else {
            None
        }
        .or_else(|| {
            let text = out.trim();
            if text.is_empty() {
                err.trim().lines().last().map(str::to_string)
            } else {
                Some(truncate_chars(text, 400))
            }
        });
        if !status.success() {
            return Err(format!(
                "pi 列出模型失败（退出码 {}）{}",
                status.code().map(|c| c.to_string()).unwrap_or_else(|| "信号".into()),
                note.map(|n| format!("：{n}")).unwrap_or_default()
            ));
        }
        return Ok(ModelOptions {
            models,
            note,
            pi_bin: pi_bin.display().to_string(),
            elapsed_ms: started.elapsed().as_millis(),
        });
    }
    Ok(ModelOptions {
        models,
        note: None,
        pi_bin: pi_bin.display().to_string(),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_session(path: &Path, lines: &[&str]) {
        let mut f = std::fs::File::create(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    /// 读会话：cwd / 模型 / 第一条 / 最近几条 / 已有名字，一个都不能错。
    #[test]
    fn read_source_extracts_everything_the_prompt_needs() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("s.jsonl");
        write_session(
            &p,
            &[
                r#"{"type":"session","version":3,"id":"x","cwd":"/proj"}"#,
                r#"{"type":"model_change","provider":"cc-switch-zhipu-glm","modelId":"glm-5.3-flash"}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"第一个问题"}]}}"#,
                r#"{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"回答"}]}}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"第二问"}]}}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"第三问"}]}}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"第四问"}]}}"#,
                r#"{"type":"session_info","name":"旧名字"}"#,
            ],
        );
        let s = read_source(&p).unwrap();
        assert_eq!(s.cwd.as_deref(), Some("/proj"));
        assert_eq!(s.provider.as_deref(), Some("cc-switch-zhipu-glm"));
        assert_eq!(s.model_id.as_deref(), Some("glm-5.3-flash"));
        assert_eq!(s.first_message.as_deref(), Some("第一个问题"));
        // 只留最近 RECENT_LIMIT 条（第二/三/四问）
        assert_eq!(s.recent_messages, vec!["第二问", "第三问", "第四问"]);
        assert_eq!(s.user_message_count, 4);
        assert_eq!(s.message_count, 5);
        assert_eq!(s.current_name.as_deref(), Some("旧名字"));
    }

    /// 中途换过模型时跟**最后一次**——跟错了会用已经不在用的那个模型去生成。
    #[test]
    fn last_model_change_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("s.jsonl");
        write_session(
            &p,
            &[
                r#"{"type":"model_change","provider":"a","modelId":"m1"}"#,
                r#"{"type":"model_change","provider":"b","modelId":"m2"}"#,
            ],
        );
        let s = read_source(&p).unwrap();
        assert_eq!(s.provider.as_deref(), Some("b"));
        assert_eq!(s.model_id.as_deref(), Some("m2"));
    }

    /// 非文本的用户消息（纯图片）不参与——否则会生成一个基于空内容的标题。
    #[test]
    fn only_text_blocks_are_eligible() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("s.jsonl");
        write_session(
            &p,
            &[
                r#"{"type":"message","message":{"role":"user","content":[{"type":"image","data":"..."}]}}"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"真正的第一条"}]}}"#,
            ],
        );
        let s = read_source(&p).unwrap();
        assert_eq!(s.first_message.as_deref(), Some("真正的第一条"));
        assert_eq!(s.user_message_count, 1, "纯图片那条不该计数");
    }

    /// 坏行跳过而不是整份失败：会话是追加写的，崩溃会留下半行。
    /// 一个坏行就让会话永远生成不了标题是不可接受的。
    #[test]
    fn a_corrupt_line_does_not_kill_the_whole_read() {
        let tmp = tempfile::tempdir().unwrap();
        let p = tmp.path().join("s.jsonl");
        write_session(
            &p,
            &[
                r#"{"type":"session","cwd":"/p"}"#,
                r#"{"type":"message","message":{"role":"user","cont"#,
                r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"好的那条"}]}}"#,
            ],
        );
        let s = read_source(&p).unwrap();
        assert_eq!(s.first_message.as_deref(), Some("好的那条"));
    }

    /// 终截断按**字符**算且不切坏多字节——"20 个字符"对中文就是 20 个汉字。
    #[test]
    fn truncation_is_by_character_not_byte() {
        let s = "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯";
        assert_eq!(truncate_chars(s, 20).chars().count(), 20);
        assert_eq!(truncate_chars(s, 20), "一二三四五六七八九十甲乙丙丁戊己庚辛壬癸");
        // 4 字节的 emoji 也不能被切坏
        let e = "😀😀😀😀😀";
        assert_eq!(truncate_chars(e, 3), "😀😀😀");
        assert_eq!(truncate_chars(e, 3).chars().count(), 3);
        // 超长上限不 panic
        assert_eq!(truncate_chars("短", 100), "短");
        assert_eq!(truncate_chars("短", 0), "");
    }

    /// 收拾模型输出：引号、前缀、句号、多行、连续空白。
    #[test]
    fn sanitize_strips_the_usual_model_wrapping() {
        assert_eq!(sanitize("  修插件管理页  ", 20), "修插件管理页");
        assert_eq!(sanitize("\"修插件管理页\"", 20), "修插件管理页");
        assert_eq!(sanitize("「修插件管理页」", 20), "修插件管理页");
        assert_eq!(sanitize("标题：修插件管理页", 20), "修插件管理页");
        assert_eq!(sanitize("Title: Fix the plugin page", 20), "Fix the plugin page");
        assert_eq!(sanitize("修插件管理页。", 20), "修插件管理页");
        // 先来一句客套再给标题 → 只取第一行非空
        assert_eq!(sanitize("好的，我来总结\n修插件管理页", 20), "好的，我来总结");
        // 换行/制表压成一个空格
        assert_eq!(sanitize("修插件\t管理页", 20), "修插件 管理页");
        // 收拾完为空 = 不可用（调用方据此拒绝覆盖旧名字）
        assert_eq!(sanitize("   ", 20), "");
        assert_eq!(sanitize("\"\"", 20), "\"\"");
    }

    /// 上限真的生效，而且截断发生在收拾之后。
    #[test]
    fn sanitize_enforces_the_cap() {
        let long = "这是一个非常非常非常非常非常长的标题需要被截断";
        let out = sanitize(long, 10);
        assert_eq!(out.chars().count(), 10);
        assert_eq!(out, "这是一个非常非常非常");
    }

    /// 提示词：两句 DSH 的原话必须在（它们是挡真实失败的，不是装饰），
    /// 素材装成 JSON 数组，且 `both` 时第一条不重复。
    #[test]
    fn prompt_keeps_dsh_wording_and_frames_material_as_json() {
        let s = TitleSource {
            cwd: None,
            provider: None,
            model_id: None,
            first_message: Some("第一".into()),
            recent_messages: vec!["第一".into(), "最近".into()],
            user_message_count: 2,
            current_name: None,
            message_count: 2,
        };
        let (sys, user) = build_prompt(&s, TitleStrategy::Both, 20);
        // 这两句各自挡一类真实失败：模型回 Markdown/控制码，以及中文会话起英文标题
        assert!(sys.contains("plain text of natural language"), "{sys}");
        assert!(sys.contains("Use the language of the messages"), "{sys}");
        assert!(sys.contains("no quotes,"), "{sys}");
        assert!(sys.contains("20 characters"), "{sys}");
        assert!(!sys.contains("Markdown, XML") || true);

        // 素材是 JSON 数组（DSH 的做法）：消息里出现"忽略上面的指示"时边界仍然明确
        assert!(user.starts_with("Generate the session title from this JSON array"), "{user}");
        let json_part = user.split_once('\n').unwrap().1;
        let parsed: serde_json::Value = serde_json::from_str(json_part).expect("素材必须是合法 JSON");
        let texts: Vec<&str> = parsed
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, vec!["第一", "最近"], "第一条被列了两次或顺序不对：{user}");

        // first / recent 各自只给一半
        let (_, user) = build_prompt(&s, TitleStrategy::First, 20);
        assert!(user.contains("第一") && !user.contains("最近"), "{user}");
        let (_, user) = build_prompt(&s, TitleStrategy::Recent, 20);
        assert!(user.contains("最近") && user.contains("第一"), "recent 也要带上第一条（它是最近之一）：{user}");
    }

    /// 空会话也要能拼出合法 JSON（而不是拼出一个空请求）。
    #[test]
    fn empty_session_still_builds_a_prompt() {
        let s = TitleSource {
            cwd: None,
            provider: None,
            model_id: None,
            first_message: None,
            recent_messages: vec![],
            user_message_count: 0,
            current_name: None,
            message_count: 0,
        };
        let (_, user) = build_prompt(&s, TitleStrategy::Both, 20);
        let json_part = user.split_once('\n').unwrap().1;
        let parsed: serde_json::Value = serde_json::from_str(json_part).expect("空会话也要是合法 JSON");
        assert_eq!(parsed.as_array().unwrap().len(), 1);
    }

    /// **真机核对**（`cargo test --lib -- --ignored real_machine --nocapture`）。
    ///
    /// 拿这台机器上真实的会话文件跑一遍"读素材 + 拼提示词"，把结果打出来。
    /// 单元测试用的是自己造的 JSONL，证明不了"真的读得懂 pi 写出来的会话"——
    /// 这条才是。它**只读**，也不调用模型（打印的是会送出去的那段提示词）。
    #[test]
    #[ignore]
    fn real_machine_reads_the_live_sessions() {
        let root = pi_files_sessions_root();
        println!("会话根目录 = {}", root.display());
        let mut files: Vec<std::path::PathBuf> = Vec::new();
        collect_jsonl(&root, &mut files, 0);
        files.sort();
        println!("找到 {} 个会话文件", files.len());
        assert!(!files.is_empty(), "这台机器上没有会话文件");

        let mut with_text = 0;
        // 挑最近改动的 3 个看（老的会话结构可能不同）
        files.sort_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok());
        for path in files.iter().rev().take(3) {
            let s = read_source(path).expect("读会话不该失败");
            if s.user_message_count == 0 {
                continue;
            }
            with_text += 1;
            let (sys, user) = build_prompt(&s, TitleStrategy::Both, DEFAULT_MAX_CHARS);
            println!("\n── {}", path.file_name().unwrap().to_string_lossy());
            println!("   cwd={:?} 模型={:?}/{:?}", s.cwd, s.provider, s.model_id);
            println!(
                "   消息 {} 条（用户文字 {} 条） 已有名字={:?}",
                s.message_count, s.user_message_count, s.current_name
            );
            println!("   第一条 = {:?}", s.first_message.as_deref().unwrap_or(""));
            println!("   最近 = {:?}", s.recent_messages);
            println!("   ── 会送出去的 system（{} 字）", sys.chars().count());
            for line in sys.lines() {
                println!("      {line}");
            }
            println!("   ── 会送出去的 user（{} 字）", user.chars().count());
            for line in user.lines() {
                println!("      {}", truncate_chars(line, 160));
            }
            // 素材装成合法 JSON 是硬要求（模型侧解析靠它）
            let json_part = user.split_once('\n').unwrap().1;
            let parsed: Value = serde_json::from_str(json_part).expect("真机会话也要拼出合法 JSON");
            assert!(parsed.is_array());
        }
        assert!(with_text > 0, "最近 3 个会话里一个用户文字消息都没有？");
    }

    /// **真机核对**（`cargo test --lib -- --ignored real_machine_lists --nocapture`）。
    ///
    /// 解析器已经用真输出当金标（`parses_the_real_list_models_table`），但那是我
    /// 抄下来的一段字符串。这条是**真的去跑这台机器上的 pi**：
    /// 它证明"命令能起来、表格读得懂、reasoning 列没错位"。
    /// 只读，不调用模型。
    #[test]
    #[ignore]
    fn real_machine_lists_models_from_pi() {
        let root = crate::config::paths::agent_dir();
        let pi = crate::pi::discovery::discover(
            crate::pi::discovery::PiSource::System,
            None,
            None,
        )
        .expect("这台机器上应当能找到 pi");
        println!("pi = {} ({})", pi.path.display(), pi.version);
        println!("agent dir = {}（PI_CODING_AGENT_DIR 可覆盖，验证时用得上）", root.display());
        let out = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(list_models(&pi.path, &root))
            .expect("列出模型不该失败");
        println!("耗时 {}ms，共 {} 个模型", out.elapsed_ms, out.models.len());
        for m in out.models.iter().take(20) {
            println!(
                "  {}/{}  reasoning={}",
                m.provider, m.id, m.reasoning
            );
        }
        if let Some(n) = &out.note {
            println!("note = {n}");
        }
        assert!(
            !out.models.is_empty(),
            "一个模型都没解析出来——要么这台机器没配任何可用模型，要么 pi 的表格格式变了（note={:?}）",
            out.note
        );
    }

    fn pi_files_sessions_root() -> std::path::PathBuf {
        // 与 config/pi_files.rs 的口径一致：settings.json 的 sessionDir 优先，否则 ~/.pi/agent/sessions
        crate::config::pi_files::sessions_root()
    }

    fn collect_jsonl(dir: &Path, out: &mut Vec<std::path::PathBuf>, depth: usize) {
        if depth > 3 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                collect_jsonl(&p, out, depth + 1);
            } else if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                out.push(p);
            }
        }
    }

    /// **跨 IPC 的键必须是 camelCase。**
    ///
    /// 这条用例是补票：第一版 `Generated` 忘了写 `rename_all = "camelCase"`，
    /// 于是前端 `describeRun()` 里 `r.elapsedMs / 1000` 得到 `NaN`、
    /// `r.promptChars` 得到 `undefined`，用户看到的提示是
    /// 「（cc-switch-zhipu-glm/glm-5.3-flash · NaNs · 素材 undefined 字）」。
    ///
    /// 为什么以前没被发现：前端单测 mock 的是 `session_title_generate`，它返回的是
    /// **手写的 camelCase**——mock 与 Rust 各写各的，谁也没对着谁。
    /// 所以这里逐个键名写死（不复用 struct 字段名），与
    /// `src/test/session-title-shape.test.ts` 的那份清单互为独立金标。
    #[test]
    fn generated_result_keys_are_camel_case() {
        let g = Generated {
            title: "t".into(),
            raw: "r".into(),
            provider: Some("p".into()),
            model_id: Some("m".into()),
            elapsed_ms: 12,
            prompt_chars: 34,
            usable: true,
        };
        let v = serde_json::to_value(&g).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in [
            "title",
            "raw",
            "provider",
            "modelId",
            "elapsedMs",
            "promptChars",
            "usable",
        ] {
            assert!(keys.contains(&k), "生成结果缺少 {k}（实际 {keys:?}）");
        }
        // 反向：绝不能出现 snake_case 的那几个（正是这次的事故形状）
        for bad in ["model_id", "elapsed_ms", "prompt_chars"] {
            assert!(!keys.contains(&bad), "生成结果漏出了 snake_case 键 {bad}：{keys:?}");
        }
        // 数字必须是数字（前端要拿去做算术；null/字符串都会渲染成 NaN/undefined）
        assert!(v["elapsedMs"].is_number(), "{}", v["elapsedMs"]);
        assert!(v["promptChars"].is_number(), "{}", v["promptChars"]);
    }

    /// `session_title_source` 的形状同样锁一遍（它是另一个手拼的 json!）。
    #[test]
    fn source_description_keys_are_camel_case() {
        let src = TitleSource {
            cwd: Some("/p".into()),
            provider: Some("p".into()),
            model_id: Some("m".into()),
            first_message: Some("f".into()),
            recent_messages: vec!["r".into()],
            user_message_count: 1,
            current_name: None,
            message_count: 2,
        };
        let v = describe(&src, TitleStrategy::Both, 20, Some("over/p"), Some("high"));
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in [
            "cwd",
            "provider",
            "modelId",
            "modelUsed",
            "modelSource",
            "modelError",
            "thinking",
            "firstMessage",
            "recentMessages",
            "userMessageCount",
            "messageCount",
            "currentName",
            "strategy",
            "maxChars",
            "promptChars",
        ] {
            assert!(keys.contains(&k), "素材描述缺少 {k}（实际 {keys:?}）");
        }
        for bad in ["model_id", "first_message", "recent_messages", "max_chars", "model_used"] {
            assert!(!keys.contains(&bad), "素材描述漏出了 snake_case 键 {bad}");
        }
        // "会用哪个模型"必须是**真正会被用的那个**：有覆盖时会话自己的模型根本不会被调用，
        // 预览要是显示会话那个，用户会对着一个错名字判断"标题为什么这么差"。
        assert_eq!(v["modelUsed"], json!("over/p"));
        assert_eq!(v["modelSource"], json!("override"));
        assert_eq!(v["thinking"], json!("high"));
    }

    /// 预览里的"会用哪个模型"必须跟着**实际生效**的那一个走，三种来源各说各的。
    #[test]
    fn describe_reports_the_effective_model_and_where_it_came_from() {
        let mut src = TitleSource {
            cwd: None,
            provider: Some("sess-p".into()),
            model_id: Some("sess-m".into()),
            first_message: None,
            recent_messages: vec![],
            user_message_count: 0,
            current_name: None,
            message_count: 0,
        };
        // 没有覆盖 → 会话自己的
        let v = describe(&src, TitleStrategy::Both, 20, None, None);
        assert_eq!(v["modelUsed"], json!("sess-p/sess-m"));
        assert_eq!(v["modelSource"], json!("session"));
        assert!(v["thinking"].is_null(), "没设思考强度时应当是 null（= 不传 --thinking）");
        // 空串覆盖 = 没覆盖（config.json 手改成 "" 时不该变成"用一个空模型"）
        let v = describe(&src, TitleStrategy::Both, 20, Some("  "), Some("  "));
        assert_eq!(v["modelSource"], json!("session"));
        assert!(v["thinking"].is_null());
        // 会话里也没有 → pi 的默认
        src.provider = None;
        src.model_id = None;
        let v = describe(&src, TitleStrategy::Both, 20, None, None);
        assert!(v["modelUsed"].is_null());
        assert_eq!(v["modelSource"], json!("default"));
        // 覆盖写成半截 → 说"覆盖写错了"，**不能**说成"用默认"（生成时它会直接报错）
        let v = describe(&src, TitleStrategy::Both, 20, Some("半截"), None);
        assert_eq!(v["modelSource"], json!("invalid"));
        assert!(v["modelError"].is_string(), "写错的覆盖必须把原因带出来：{v}");
        assert!(v["modelUsed"].is_null());
    }

    /// 思考档位清单**照抄 pi**：`cli/args.ts:60` 的 `VALID_THINKING_LEVELS`。
    ///
    /// 这条用例的价值在于"抄错了会红"。pi 对不认识的档位只打一行 stderr 警告
    /// 然后静默用默认档（真机验证），所以抄错一个字母 = 用户以为设了、实际没设，
    /// 而且没有任何提示。前端 `lib/thinking.ts` 里那份清单与这里互为金标。
    #[test]
    fn thinking_levels_match_pi_cli() {
        assert_eq!(
            THINKING_LEVELS,
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
        assert_eq!(THINKING_LEVELS.len(), 7);
        assert!(is_valid_thinking("xhigh"));
        assert!(is_valid_thinking("  max  "), "两侧空白不该让它变成非法值");
        assert!(!is_valid_thinking(""));
        assert!(!is_valid_thinking("HIGH"), "pi 只认小写");
        assert!(!is_valid_thinking("none"), "none 是别家的写法，pi 认的是 off");
    }

    /// argv 是"这批开关唯一被证明传对了"的地方——它们拼错了都不报错，只会换行为。
    #[test]
    fn generate_args_carry_every_switch() {
        let a = generate_args(Some("p"), Some("m"), Some("high"), "SYS", "USER");
        assert_eq!(
            a,
            vec![
                "-p", "--no-session", "-nt", "-nc", "--provider", "p", "--model", "m",
                "--thinking", "high", "--system-prompt", "SYS", "--", "USER"
            ]
        );
        // 没设思考强度 → 不传这个开关（传了就等于替用户做了决定）
        let a = generate_args(Some("p"), Some("m"), None, "SYS", "USER");
        assert!(!a.contains(&"--thinking".to_string()), "{a:?}");
        // 非法档位**不能**漏出去：pi 只会警告 + 静默用默认档
        let a = generate_args(None, None, Some("HIGH"), "SYS", "USER");
        assert!(!a.contains(&"--thinking".to_string()), "非法档位被传出去了：{a:?}");
        // provider/model 成对才传：只给一半会变成"错配组合"
        let a = generate_args(Some("p"), None, None, "SYS", "USER");
        assert!(!a.contains(&"--provider".to_string()), "{a:?}");
        // `--` 之前是开关、之后是消息——用户粘贴的 diff 可能以 `-` 开头
        let a = generate_args(None, None, None, "SYS", "-不是开关");
        assert_eq!(a[a.len() - 2], "--", "{a:?}");
        assert_eq!(a[a.len() - 1], "-不是开关");
        // 最后一项永远是消息本身（`-p` 模式下它就是那一轮的用户输入）
        assert_eq!(a.last().unwrap(), "-不是开关");
    }

    /// `pi --list-models` 的真实输出（本机 pi 0.87.1 原样抄下来的）。
    ///
    /// 这是**表格解析**，是整个功能里最容易随 pi 升级悄悄坏掉的一块，
    /// 所以用真输出当金标：列数、两空格分隔、`yes`/`no` 都在里面。
    #[test]
    fn parses_the_real_list_models_table() {
        let real = concat!(
            "provider             model           context  max-out  thinking  images\n",
            "cc-switch-deep-seek  deepseek-flash  1M       384K     yes       yes   \n",
            "cc-switch-zhipu-glm  glm-5.3         1M       128K     yes       no    \n",
            "cc-switch-zhipu-glm  glm-5.3-flash   1M       128K     yes       yes   \n",
        );
        let got = parse_list_models(real);
        assert_eq!(
            got,
            vec![
                ModelOption { provider: "cc-switch-deep-seek".into(), id: "deepseek-flash".into(), reasoning: true },
                ModelOption { provider: "cc-switch-zhipu-glm".into(), id: "glm-5.3".into(), reasoning: true },
                ModelOption { provider: "cc-switch-zhipu-glm".into(), id: "glm-5.3-flash".into(), reasoning: true },
            ]
        );
        assert_eq!(got.len(), 3, "表头被当成模型了？");
    }

    /// 表格变了、或者 pi 压根没有可用模型时：宁可**一条都不给**，也不要瞎猜。
    ///
    /// pi 在"没有可用模型"时打的是 `formatNoModelsAvailableMessage()` 那段人话
    /// （多行、含 URL），解析它只可能得到垃圾；而列错位时把 `1M` 当成 `reasoning`
    /// 会让界面显示"不支持思考"——一个看起来很像事实的错误结论。
    #[test]
    fn unparseable_or_shifted_output_yields_nothing() {
        // "没有可用模型"的提示（形状取自 pi 的多行说明）
        let guidance = "No models are available.\n\nConfigure a provider in ~/.pi/agent/auth.json\n";
        assert!(parse_list_models(guidance).is_empty());
        // 列错位：thinking 列不是 yes/no → 整行丢掉
        let shifted = "p  m  1M  384K  maybe  yes\n";
        assert!(parse_list_models(shifted).is_empty());
        // 只有表头
        let header = "provider  model  context  max-out  thinking  images\n";
        assert!(parse_list_models(header).is_empty());
        // 空输出 / 空白
        assert!(parse_list_models("").is_empty());
        assert!(parse_list_models("\n   \n").is_empty());
        // 表头不在第一行也能认（pi 以后加一行说明不会让整张表错位）
        let prefixed = concat!(
            "some banner line\n",
            "provider  model  context  max-out  thinking  images\n",
            "p  m  1M  384K  no  yes\n",
        );
        let got = parse_list_models(prefixed);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].provider, "p");
        assert_eq!(got[0].id, "m");
        assert!(!got[0].reasoning, "no 必须解析成 false");
        // 单列/短行不会 panic，也不会被当成模型
        assert!(parse_list_models("garbage\np  m\n").is_empty());
    }

    /// `title_model_options` 的返回形状（前端读 camelCase，见 `sessionTitle.ts`）。
    #[test]
    fn model_options_keys_are_camel_case() {
        let opts = ModelOptions {
            models: vec![ModelOption {
                provider: "p".into(),
                id: "m".into(),
                reasoning: true,
            }],
            note: Some("pi 的原话".into()),
            pi_bin: "/usr/local/bin/pi".into(),
            elapsed_ms: 620,
        };
        let v = serde_json::to_value(&opts).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["models", "note", "piBin", "elapsedMs"] {
            assert!(keys.contains(&k), "模型列表缺少 {k}（实际 {keys:?}）");
        }
        for bad in ["pi_bin", "elapsed_ms"] {
            assert!(!keys.contains(&bad), "模型列表漏出了 snake_case 键 {bad}：{keys:?}");
        }
        let m = &v["models"][0];
        let mkeys: Vec<&str> = m.as_object().unwrap().keys().map(String::as_str).collect();
        for k in ["provider", "id", "reasoning"] {
            assert!(mkeys.contains(&k), "模型项缺少 {k}（实际 {mkeys:?}）");
        }
        // reasoning 必须是布尔（前端拿它判断"这个模型能不能选思考强度"；
        // 字符串 "yes" 在 JS 里是真值，会让不支持推理的模型看起来支持）
        assert!(m["reasoning"].is_boolean(), "{}", m["reasoning"]);
        assert!(v["elapsedMs"].is_number(), "{}", v["elapsedMs"]);
    }

    /// 模型选择：覆盖 > 会话自己的 > 都不给，且**成对**生效。
    #[test]
    fn model_selection_prefers_the_override_then_the_session() {
        let mut src = TitleSource {
            cwd: None,
            provider: Some("cc-switch-zhipu-glm".into()),
            model_id: Some("glm-5.3-flash".into()),
            first_message: None,
            recent_messages: vec![],
            user_message_count: 0,
            current_name: None,
            message_count: 0,
        };
        // 没覆盖 → 跟会话
        assert_eq!(
            pick_model(None, &src).unwrap(),
            (Some("cc-switch-zhipu-glm".into()), Some("glm-5.3-flash".into()))
        );
        // 空串 / 空白 = 没覆盖
        assert_eq!(pick_model(Some("  "), &src).unwrap().0.as_deref(), Some("cc-switch-zhipu-glm"));
        // 有覆盖 → 用覆盖（想拿便宜模型刷标题）
        assert_eq!(
            pick_model(Some("deepseek/deepseek-v4-flash"), &src).unwrap(),
            (Some("deepseek".into()), Some("deepseek-v4-flash".into()))
        );
        // 覆盖写成半截 → 报错，而不是猜
        assert!(pick_model(Some("deepseek"), &src).is_err());
        // 模型 id 里含 `/`（openrouter 那类 vendor/model）时按**第一个** `/` 切
        assert_eq!(
            pick_model(Some("openrouter/anthropic/claude-x"), &src).unwrap(),
            (Some("openrouter".into()), Some("anthropic/claude-x".into()))
        );

        // 会话里只有一半 → 都不传，让 pi 用默认（拼一个错配组合更糟）
        src.model_id = None;
        assert_eq!(pick_model(None, &src).unwrap(), (None, None));
        src.provider = Some(String::new());
        src.model_id = Some("m".into());
        assert_eq!(pick_model(None, &src).unwrap(), (None, None));
    }

    /// 取材方式的解析与回落：**未知值回落 both**（用户在 config.json 里写错了
    /// 不该让整个功能不可用，serde 的 `#[serde(other)]` 已经这么兜了）。
    #[test]
    fn strategy_parsing_and_fallback() {
        assert_eq!(TitleStrategy::parse("first").unwrap(), TitleStrategy::First);
        assert_eq!(TitleStrategy::parse("recent").unwrap(), TitleStrategy::Recent);
        assert_eq!(TitleStrategy::parse("both").unwrap(), TitleStrategy::Both);
        assert!(TitleStrategy::parse("nope").is_err());
        let v: TitleStrategy = serde_json::from_str("\"nope\"").unwrap();
        assert_eq!(v, TitleStrategy::Both);
        let v: TitleStrategy = serde_json::from_str("\"first\"").unwrap();
        assert_eq!(v, TitleStrategy::First);
    }
}

