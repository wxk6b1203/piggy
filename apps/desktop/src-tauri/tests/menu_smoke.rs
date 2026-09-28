//! 系统菜单的**结构**核对（`harness = false`：必须在主线程跑）。
//!
//! 为什么单独一个测试二进制：muda 会直接 panic——
//! `` `muda::MenuChild` can only be created on the main thread ``，
//! 而 `cargo test` 的普通用例跑在 worker 线程上。`harness = false` 的测试
//! 由自己的 `main` 在主线程执行，正好合适。
//!
//! 核对三件事（都是"坏了也看不出来"的那类）：
//!   ① 菜单能建起来（结构假设不成立时 `build_app_menu` 会返回 Err，而不是静默少一条）；
//!   ② 「许可与第三方声明」真的在菜单里（GPL §5(d) 的入口）；
//!   ③ **Edit 子菜单还在**——这是最要紧的一条：如果哪天有人图省事改成"自己拼一个菜单"，
//!      ⌘C/⌘V/⌘A 会在整个应用里失效，而界面上完全看不出来，只有用户想复制回复时才发现。
use piggy_lib::legal::{build_app_menu, MENU_ID_LEGAL};

fn main() {
    let app = tauri::test::mock_app();
    let menu = match build_app_menu(app.handle()) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("❌ 构建应用菜单失败：{e}");
            std::process::exit(1);
        }
    };

    let subs = menu.items().expect("菜单项读取失败");
    let mut found_legal: Option<String> = None;
    let mut edit_items = 0usize;
    let mut submenu_ids: Vec<String> = Vec::new();

    // ⚠️ 子菜单 id 认不得：`Menu::default` 里只有 Window/Help 带显式 id
    // （`__tauri_window_menu__` / `__tauri_help_menu__`），App/File/Edit/View 都是
    // muda 自动生成的数字 id（实测 "15"/"18"/"27"/"30"）。所以这里按**标题**找。
    for it in &subs {
        let tauri::menu::MenuItemKind::Submenu(sub) = it else { continue };
        let id = sub.id().as_ref().to_string();
        let title = sub.text().unwrap_or_default();
        submenu_ids.push(format!("{title}({id})"));
        let items = sub.items().expect("子菜单项读取失败");
        if title == "Edit" {
            edit_items = items.len();
        }
        for inner in items {
            if inner.id().as_ref() == MENU_ID_LEGAL {
                found_legal = Some(title.clone());
            }
        }
    }

    println!("子菜单 = {submenu_ids:?}");
    println!("Edit 子菜单项数 = {edit_items}");
    println!("许可条目所在子菜单 = {found_legal:?}");

    let mut bad = Vec::new();
    // 「关于」正下方那条：0 号位是预定义的 About，1 号位必须是我们的条目
    // （用户点 About 的地方就是这儿——位置错了等于没人找得到）
    let mut placement = String::from("(非 macOS)");
    #[cfg(target_os = "macos")]
    {
        let first = subs.first().and_then(|it| match it {
            tauri::menu::MenuItemKind::Submenu(s) => Some(s),
            _ => None,
        });
        match first {
            Some(app_menu) => {
                let items = app_menu.items().expect("App 子菜单读取失败");
                let kinds: Vec<String> = items
                    .iter()
                    .map(|i| match i {
                        tauri::menu::MenuItemKind::Predefined(_) => {
                            format!("predefined:{}", i.id().as_ref())
                        }
                        _ => format!("item:{}", i.id().as_ref()),
                    })
                    .collect();
                println!("App 子菜单前几项 = {kinds:?}");
                placement = kinds.first().cloned().unwrap_or_default();
                let at_one = items.get(1).map(|i| i.id().as_ref().to_string());
                if at_one.as_deref() != Some(MENU_ID_LEGAL) {
                    bad.push(format!(
                        "许可条目不在「关于」正下方（1 号位是 {at_one:?}）"
                    ));
                }
                let zero_is_predefined = matches!(
                    items.first(),
                    Some(tauri::menu::MenuItemKind::Predefined(_))
                );
                if !zero_is_predefined {
                    bad.push("App 子菜单 0 号位不是预定义的「关于」".into());
                }
            }
            None => bad.push("macOS 上第一个子菜单不是 App 子菜单".into()),
        }
    }

    if found_legal.is_none() {
        bad.push(format!("菜单里没有 {MENU_ID_LEGAL}"));
    }
    // Edit 必须是默认菜单那一套（undo/redo/sep/cut/copy/paste/select_all = 7 项）
    if edit_items < 7 {
        bad.push(format!("Edit 子菜单只剩 {edit_items} 项——⌘C/⌘V 可能已经失效"));
    }
    if subs.len() < 4 {
        bad.push(format!("顶层子菜单只有 {} 个，默认菜单结构变了", subs.len()));
    }

    println!("App 子菜单 0 号位 = {placement}");

    if bad.is_empty() {
        println!("✅ 系统菜单结构正常");
    } else {
        for b in &bad {
            eprintln!("❌ {b}");
        }
        std::process::exit(1);
    }
}
