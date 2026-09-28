//! 许可与第三方声明（docs/03 §2.17、docs/17 §2.7）。
//!
//! ## 为什么需要它（而不是只放一个 LICENSE 文件）
//!
//! GPLv3 §0 给"Appropriate Legal Notices"下了定义：交互界面必须显示
//! ①版权声明 ②无担保声明 ③可以按本许可再分发 ④**怎么看许可全文**。
//! §5(d) 进一步要求**有交互界面的作品**都得显示它。所以光在仓库里放一份 `LICENSE`
//! 是不够的——用户拿到的是安装包，不是 git 仓库。
//!
//! 两道出口：
//!   * **系统菜单**（`install_app_menu`）：App 菜单里「关于」照旧走系统面板
//!     （版权行来自 `bundle.copyright`），它下面挂一条「许可与第三方声明」；
//!   * **应用内对话框**（前端 `AboutDialog`）：显示版权 / 无担保 / 许可名 +
//!     GPLv3 全文 + 第三方组件表。系统"关于"面板是个信息框，塞不下 674 行原文，
//!     所以全文必须落在应用内（这正是 §0 那句 "how to view a copy of this License"）。
//!
//! ## GPL 原文是**嵌进来的**，不是抄进来的
//!
//! `include_str!` 直接指向仓库根那一份 `LICENSE`（编译期嵌入）：既不会漂移，
//! 也不需要再复制一份到 resources/。用户看到的就是仓库里那一份，
//! 而它的 sha256 由 `src/test/license.test.ts` 锁着（等于与 gnu.org 逐字节一致）。

use serde_json::{json, Value};

/// Piggy 自己的版权行（与 README「授权」一节、`bundle.copyright` 同一句话）。
pub const COPYRIGHT: &str = "Copyright (C) 2026 wxk6b1203";
/// Piggy 自己的 SPDX 标识。**`or later` 只能由项目自己的声明表达**——
/// GPLv3 原文里没有这句话。
pub const SPDX: &str = "GPL-3.0-or-later";

/// GPLv3 全文（编译期嵌入仓库根的 `LICENSE`）。
pub const GPL_TEXT: &str = include_str!("../../../../LICENSE");

/// 系统菜单里那条菜单项的 id 与文案。
pub const MENU_ID_LEGAL: &str = "legal-notices";
pub const MENU_LABEL_LEGAL: &str = "许可与第三方声明";

/// 一条第三方组件（**跨 IPC**，键名 camelCase）。
///
/// 这份清单与 `THIRD_PARTY_NOTICES.md` 的二级标题**互为金标**：
/// `third_party_matches_the_notices_file` 双向核对（少一条、多一条都红）。
/// 分开写两遍是刻意的——照规矩 27，两份手写清单必须各自有测试对着自己的实现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThirdParty {
    /// 组件名（与 `THIRD_PARTY_NOTICES.md` 的 `## ` 标题前缀一致）
    pub name: &'static str,
    /// 许可（SPDX 或官方名字）
    pub license: &'static str,
    /// 版权人——署名义务的主体
    pub holder: &'static str,
    /// Piggy 用了它的哪一部分（一句话，界面直接显示）
    pub usage: &'static str,
}

/// 实打实复用/分发了的上游组件。**新增可复用资产时必须同时改这里和
/// `THIRD_PARTY_NOTICES.md`**（测试会逼你改，见上）。
pub const THIRD_PARTY: &[ThirdParty] = &[
    ThirdParty {
        name: "pi",
        license: "MIT",
        holder: "Copyright (c) 2025 Mario Zechner",
        usage: "驱动会话的编码代理；full SKU 会把 standalone 随安装包分发",
    },
    ThirdParty {
        name: "DeepSeek Harness",
        license: "MIT",
        holder: "Copyright (c) 2026 DeepSeek",
        usage: "设计 token 数值（tokens.css 由脚本提取）与交互规格的参照",
    },
    ThirdParty {
        name: "@vscode/codicons",
        license: "CC-BY-4.0（图标字形）/ MIT（构建代码）",
        holder: "Microsoft Corporation",
        usage: "UI 图标字体",
    },
    ThirdParty {
        name: "seti-ui",
        license: "MIT",
        holder: "Copyright (c) 2014 Jesse Weed",
        usage: "文件类型图标（WOFF 字体）",
    },
    ThirdParty {
        name: "Monaco Editor",
        license: "MIT",
        holder: "Microsoft Corporation",
        usage: "编辑器与预览基座",
    },
    ThirdParty {
        name: "VS Code 内置主题",
        license: "MIT",
        holder: "Microsoft Corporation",
        usage: "Monaco 的语法着色规则（只有 tokenColors）",
    },
];

/// 交给前端的完整声明（**跨 IPC**，键名 camelCase）。
pub fn notices(version: &str) -> Value {
    json!({
        "name": "Piggy",
        "version": version,
        "copyright": COPYRIGHT,
        "spdx": SPDX,
        "licenseName": "GNU General Public License v3.0 or later",
        "//": "无担保那句是 §0 明确要求显示的三件事之一，不要为了好看删掉",
        "warranty": "本程序是自由软件：你可以按自由软件基金会发布的 GNU 通用公共许可证\
（第 3 版，或你选择的任何更新版本）重新分发和/或修改它。本程序的分发是希望它有用，\
但没有任何担保，甚至没有适销性或特定用途适用性的默示担保。",
        "licenseUrl": "https://www.gnu.org/licenses/gpl-3.0.html",
        "gplText": GPL_TEXT,
        "thirdParty": THIRD_PARTY,
    })
}

/// 把「许可与第三方声明」挂进系统菜单。
///
/// **起点必须是 `Menu::default`**：它带着标准的 Edit 子菜单
/// （undo/redo/cut/copy/paste/select_all 的加速键）。自己从零搭一个菜单的话，
/// ⌘C/⌘V 会在整个应用里失效——而这种坏法在界面上完全看不出来，
/// 只有用户想复制一段回复时才发现（本项目最忌讳的静默失效）。
///
/// 位置：macOS 放 **App 子菜单里「关于」的正下方**（用户找 About 就在那儿）；
/// 其它平台放 Help（`Menu::default` 在非 macOS 上不带 App 子菜单）。
/// 泛型是**为了可测**：`tauri::test::mock_app()` 用的是 `MockRuntime`，
/// 而应用跑的是 `Wry`。不泛型化就只能靠肉眼看菜单（那正是漏掉一条的方式）。
pub fn build_app_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::menu::Menu<R>, String> {
    use tauri::menu::{Menu, MenuItem};
    // `MenuItemKind` 只在 macOS 那一支用到 —— **条件导入**是必须的：
    // 无条件导入时，非 macOS 编译会报 `unused import`（我在 Windows 上真机编译才看到，
    // 因为 macOS 这边这一支是编进去的）。
    #[cfg(target_os = "macos")]
    use tauri::menu::MenuItemKind;

    let menu = Menu::default(app).map_err(|e| e.to_string())?;
    let legal = MenuItem::with_id(app, MENU_ID_LEGAL, MENU_LABEL_LEGAL, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let items = menu.items().map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    {
        // 第一项就是 App 子菜单（`Menu::default` 在 macOS 上先放它）
        match items.first() {
            Some(MenuItemKind::Submenu(sub)) => {
                // 0 号位是「关于 Piggy」→ 我们插在它下面
                sub.insert(&legal, 1).map_err(|e| e.to_string())?;
            }
            // 结构变了**不能静默**丢掉这条：退到 Help，并把原因带出去让调用方吼一声
            _ => {
                append_to_help(&items, &legal)?;
                eprintln!("[piggy] 注意：App 子菜单结构不认识，许可条目退到了 Help");
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        append_to_help(&items, &legal)?;
    }

    Ok(menu)
}

/// 把 [`build_app_menu`] 的结果装到应用上。
pub fn install_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let menu = build_app_menu(app)?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

/// 退路：放进 Help 子菜单（非 macOS 的正常路径，也是 macOS 的兜底）。
#[allow(dead_code)]
fn append_to_help<R: tauri::Runtime>(
    items: &[tauri::menu::MenuItemKind<R>],
    legal: &tauri::menu::MenuItem<R>,
) -> Result<(), String> {
    use tauri::menu::{MenuItemKind, HELP_SUBMENU_ID};
    for it in items {
        if let MenuItemKind::Submenu(sub) = it {
            if sub.id().as_ref() == HELP_SUBMENU_ID {
                return sub.append(legal).map_err(|e| e.to_string());
            }
        }
    }
    Err("Help 子菜单不在默认菜单里（tauri 版本变了？）".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端读的是 camelCase 的键（`legal_notices` 是手拼的 `json!`）。
    /// 与 `tests/ipc_contract.rs` 的那条互为独立清单。
    #[test]
    fn notices_keys_are_camel_case() {
        let v = notices("0.1.0");
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in [
            "name",
            "version",
            "copyright",
            "spdx",
            "licenseName",
            "warranty",
            "licenseUrl",
            "gplText",
            "thirdParty",
        ] {
            assert!(keys.contains(&k), "许可声明缺少 {k}（实际 {keys:?}）");
        }
        for bad in ["license_name", "license_url", "gpl_text", "third_party"] {
            assert!(!keys.contains(&bad), "许可声明漏出了 snake_case 键 {bad}：{keys:?}");
        }
        // 第三方表里每一项也必须是 camelCase
        let row = &v["thirdParty"][0];
        for k in ["name", "license", "holder", "usage"] {
            assert!(row.get(k).is_some(), "第三方项缺少 {k}：{row}");
        }
    }

    /// §0 要求界面显示的**三件事**：版权、无担保、怎么看全文。
    /// 少任何一件，这条声明就不成立——所以逐个断言（不是"看着挺全"）。
    #[test]
    fn notices_carry_the_three_things_gpl_requires() {
        let v = notices("0.1.0");
        assert_eq!(v["copyright"], COPYRIGHT);
        assert!(v["copyright"].as_str().unwrap().contains("2026 wxk6b1203"));
        let warranty = v["warranty"].as_str().unwrap();
        assert!(warranty.contains("没有任何担保"), "无担保声明没了：{warranty}");
        assert!(warranty.contains("任何更新版本"), "or later 的授权没了：{warranty}");
        assert!(v["licenseUrl"].as_str().unwrap().starts_with("https://www.gnu.org/"));
        // 全文真的带上了（而不是一句"详见 LICENSE"）
        let text = v["gplText"].as_str().unwrap();
        assert!(text.contains("GNU GENERAL PUBLIC LICENSE"));
        assert!(text.contains("Version 3, 29 June 2007"));
        assert!(text.contains("END OF TERMS AND CONDITIONS"));
    }

    /// 嵌入的原文 = 仓库里那一份 = 与 gnu.org 逐字节一致的那一份（35149 字节）。
    ///
    /// 这个字节数是**上游事实**（`sha256 3972dc97…`）。它变了说明有人改了 LICENSE，
    /// 而 GPL 原文写着 "changing it is not allowed"——先去看 `license.test.ts`。
    #[test]
    fn gpl_text_is_the_verbatim_upstream_file() {
        assert_eq!(GPL_TEXT.len(), 35149, "嵌入的 LICENSE 不再是 gnu.org 那一份");
        assert_eq!(GPL_TEXT.lines().count(), 674);
    }

    /// 第三方清单与 `THIRD_PARTY_NOTICES.md` **双向**核对。
    ///
    /// 单向检查不够：只查"表里的都能在文档里找到"会漏掉"文档里新登记了一个组件、
    /// 但界面（和安装包）里没有它"——那正是署名漏掉的方式。
    #[test]
    fn third_party_matches_the_notices_file() {
        let md = include_str!("../../../../THIRD_PARTY_NOTICES.md");
        // 文档里的组件标题（`## xxx（…）`）；`## 待登记` 不是组件
        let headings: Vec<&str> = md
            .lines()
            .filter_map(|l| l.strip_prefix("## "))
            .map(str::trim)
            .filter(|h| !h.starts_with("待登记"))
            .collect();
        assert!(!headings.is_empty(), "没解析出任何组件标题，核对失去意义");

        for tp in THIRD_PARTY {
            assert!(
                headings.iter().any(|h| h.starts_with(tp.name)),
                "THIRD_PARTY 里的 {} 没登记进 THIRD_PARTY_NOTICES.md（现有：{headings:?}）",
                tp.name
            );
            // 许可名与版权人也得对得上（写错版权人 = 署名错了）
            assert!(
                md.contains(tp.holder) || md.contains(tp.holder.trim_start_matches("Copyright ")),
                "{} 的版权人 {} 没出现在文档里",
                tp.name,
                tp.holder
            );
        }
        for h in &headings {
            assert!(
                THIRD_PARTY.iter().any(|tp| h.starts_with(tp.name)),
                "THIRD_PARTY_NOTICES.md 登记了 {h}，但界面里的第三方表没有它"
            );
        }
    }
}
