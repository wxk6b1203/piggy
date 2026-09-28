//! 路径分隔符纪律（docs/03 §2.18）：生产代码里**不许**在 `join("…")` 的字面量里写
//! 路径分隔符。
//!
//! 起因是 Windows 事故：`home.join(".pi/agent")` 在 Windows 上拼出
//! `C:\Users\x\.pi/agent`（一半反斜杠一半正斜杠），用户看到的默认会话目录则是
//! `.pi/agent\sessions`——主目录没解析出来 + 混合分隔符，两个问题叠在一起。
//! 正确写法是 `home.join(".pi").join("agent")`，分隔符由 `PathBuf` 按平台决定。
//!
//! **为什么用静态扫描**：这个 bug 在 macOS/Linux 上**测不出来**——
//! `PathBuf::from("C:\\Users\\x").join(".pi/agent")` 与 `.join(".pi").join("agent")`
//! 在 Unix 上产生**完全相同**的路径（`/` 是分隔符，`\` 只是普通字符）。
//! 所以唯一的跨平台守卫就是这条源码规则。
//!
//! 豁免：
//! - 注释行（文档里写 `~/.pi/agent` 是正常的，且应当继续这么写）
//! - `join("/")` 这类**故意的**正斜杠拼接（`plugin::relative_glob` 要把路径转成
//!   pi 认识的 `a/b` 形式，那是字符串约定，不是文件系统路径）
//! - 含空格的按显示分隔符处理（`THINKING_LEVELS.join(" / ")`）
//! - `#[cfg(test)]` 之后的测试夹具（那些路径只在临时目录里用，且 Windows 的
//!   `fs` 也接受正斜杠；规则只约束生产代码）

use std::path::{Path, PathBuf};

/// 抽出所有 `join("<lit>")` 里的字面量（简化的词法扫描：字面量里不含转义引号）。
fn join_literals(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line;
    while let Some(pos) = rest.find(".join(\"") {
        let after = &rest[pos + ".join(\"".len()..];
        match after.find('"') {
            Some(end) => {
                out.push(after[..end].to_string());
                rest = &after[end..];
            }
            None => break,
        }
    }
    out
}

/// 违规判定：字面量里含 `/`，且不是单独一个 `/`（故意的归一化）、不含空格（显示分隔符）。
fn is_violation(lit: &str) -> bool {
    lit.contains('/') && lit != "/" && !lit.contains(' ')
}

fn scan_source(src: &str) -> Vec<(usize, String)> {
    let mut hits = Vec::new();
    for (i, line) in src.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") {
            continue; // 注释（含文档注释）不约束
        }
        // 测试模块之后的夹具不约束
        if trimmed.starts_with("#[cfg(test)]") {
            break;
        }
        for lit in join_literals(line) {
            if is_violation(&lit) {
                hits.push((i + 1, lit));
            }
        }
    }
    hits
}

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_sources(&p, out);
        } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
            out.push(p);
        }
    }
}

#[test]
fn production_sources_have_no_separator_literals_in_joins() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    assert!(files.len() > 30, "只扫到 {} 个源文件，路径不对？", files.len());

    let mut violations: Vec<String> = Vec::new();
    for f in &files {
        let Ok(text) = std::fs::read_to_string(f) else {
            continue;
        };
        for (line, lit) in scan_source(&text) {
            violations.push(format!(
                "{}:{line}: join(\"{lit}\") —— 改成 join(\"..\").join(\"..\")",
                f.strip_prefix(&src).unwrap_or(f).display()
            ));
        }
    }
    assert!(
        violations.is_empty(),
        "生产代码里出现了带分隔符的 join 字面量（Windows 上会拼出混合分隔符路径）:\n{}",
        violations.join("\n")
    );
}

/* ---------------- 扫描器自检（守卫本身不能是哑的） ---------------- */

#[test]
fn scanner_catches_the_original_windows_bug() {
    let bad = r#"    let dir = home.join(".pi/agent");"#;
    assert_eq!(scan_source(bad), vec![(1, ".pi/agent".to_string())]);
    // 修好之后的写法不报
    let good = r#"    let dir = home.join(".pi").join("agent");"#;
    assert!(scan_source(good).is_empty());
    // 注释、故意的正斜杠归一化、显示分隔符都豁免
    assert!(scan_source(r#"/// 默认 ~/.pi/agent/sessions"#).is_empty());
    assert!(scan_source(r#"    let rel = out.join("/");"#).is_empty());
    assert!(scan_source(r#"    let s = levels.join(" / ");"#).is_empty());
    // 单测夹具区不约束
    assert!(scan_source("#[cfg(test)]\nmod tests { let p = d.join(\"a/b\"); }").is_empty());
}
