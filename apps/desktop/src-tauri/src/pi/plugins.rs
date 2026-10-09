//! 捆绑的 pi 插件：目录发现、去重、开关（docs/06 §7）。
//!
//! ## 为什么要有这一层
//!
//! Piggy 随包带几个**给模型用的** pi 扩展（今天只有一个：`pi-ask` 结构化提问，
//! 带 `/plan` 计划模式）。它们与 `piggy-guard.js`/`piggy-bridge.js` 那种"基础设施脚本"
//! 的区别是：那些是 Piggy 自己跑得起来的前提，这些是可选功能，用户能关。
//!
//! ## 重复加载会**炸掉整个 pi 进程**（真机实测，必须挡）
//!
//! pi 的资源加载器对"两个扩展注册了同一个工具名"的处理是：把错误塞进
//! `extensionsResult.errors` → 变成启动诊断 → `process.exit(1)`。也就是说用户自己
//! 装过一份同名插件（`~/.pi/agent/extensions/pi-ask`，或者 `pi install` 过），
//! 我们再 `-e` 注入一份，**结果不是"两份都在"，而是 pi 根本起不来**。
//!
//! 所以注入前先扫一遍 pi 自己的发现目录，同一个名字（realpath 比较）已经在里面就不注入，
//! 并把这件事报给界面（`skipped`）。

use std::path::{Path, PathBuf};

/// 插件自述文件（放在插件目录里，随包分发）。
///
/// 为什么需要它：限制档位下 pi 的 `--tools` 白名单会**把插件工具整个过滤掉**（真机验证，
/// 见 docs/15 规矩 8）。要让"插件在限制档位下也能用"，就得知道**这个插件提供哪些工具名**，
/// 再把它们加进白名单 —— 名字不能靠猜（猜错 = 白名单里写了个不存在的名字，模型看到的
/// 工具表还是缺的，而界面上一切正常）。所以让插件自己申报，`pi/plugins.rs` 负责读。
const MANIFEST: &str = "piggy-plugin.json";

/// 插件清单（`piggy-plugin.json`）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
pub struct Manifest {
    /// 插件名（通常与目录名一致）
    #[serde(default)]
    pub name: String,
    /// 界面上的中文名
    #[serde(default)]
    pub title: String,
    /// 一句话说明
    #[serde(default)]
    pub description: String,
    /// 许可证标识（SPDX）
    #[serde(default)]
    pub license: String,
    /// 入口文件（相对插件目录）
    #[serde(default)]
    pub entry: String,
    /// 这个插件注册的工具名（限制档位下要被加进 `--tools` 白名单）
    #[serde(default)]
    pub tools: Vec<String>,
    /// 注册的斜杠命令名
    #[serde(default)]
    pub commands: Vec<String>,
}

/// 读一个插件目录的清单；没有清单或读不动时返回 None（不编造工具名）。
///
/// @param dir - 插件目录
/// @returns 清单
pub fn read_manifest(dir: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(dir.join(MANIFEST)).ok()?;
    serde_json::from_str::<Manifest>(&raw).ok()
}

/// 给定"这次要注入的插件目录"，收集它们申报的工具名。
///
/// **不看配置**，只认调用方已经决定注入的目录
/// （`spawn` 路径上 `bundled_extensions` 就是最终清单）—— 白名单必须与"真的注入了什么"
/// 严格一致，多一个名字就是骗模型。
///
/// @param dirs - 本次注入的插件目录
/// @returns 去重后的工具名
pub fn plugin_tools_for(dirs: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for dir in dirs {
        let Some(m) = read_manifest(dir) else {
            continue;
        };
        for t in m.tools {
            if !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

/// 一个捆绑插件的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledPlugin {
    /// 插件名（目录名，例如 `pi-ask`）
    pub name: String,
    /// 仓库/安装包里的插件目录
    pub dir: PathBuf,
    /// 要不要注入（用户关了 / 用户自己装过同名 → false）
    pub inject: bool,
    /// 不注入的原因（给界面看的一句话）；`inject` 为真时是 None
    pub skipped: Option<String>,
}

/// pi 会去自动发现扩展的三个位置（`~/.pi/agent/extensions`、项目 `.pi/extensions`，
/// 以及用户级 `extensions` 的同级 npm 包目录）。这里只做**名字级**的粗筛：
/// 目的是避免"同名重复加载 → exit(1)"，不是复刻 pi 的完整发现逻辑。
///
/// @param home - 用户主目录（拿不到就只查项目目录）
/// @param cwd - 会话工作目录（项目级扩展放在 `<cwd>/.pi/extensions`）
/// @returns 可能存在的扩展目录候选
fn discovery_dirs(home: Option<&Path>, cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(h) = home {
        out.push(h.join(".pi").join("agent").join("extensions"));
    }
    if let Some(c) = cwd {
        out.push(c.join(".pi").join("extensions"));
    }
    out
}

/// `name` 是不是已经存在于 pi 的发现目录里（同名目录，或同名 `.js`/`.ts` 单文件）。
///
/// 比较用**规范化后的路径**（realpath）：用户很可能把插件目录软链到发现目录里
/// （`~/.pi/agent/extensions/pi-todo -> ~/Project/pi-todo`），路径字面量比较会漏。
///
/// @param dirs - {@link discovery_dirs} 的结果
/// @param name - 插件名
/// @returns 命中的路径（用于给用户看"你装在哪"）
pub fn existing_install(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    for dir in dirs {
        let candidates = [
            dir.join(name),
            dir.join(format!("{name}.js")),
            dir.join(format!("{name}.ts")),
            dir.join(format!("{name}.mjs")),
        ];
        for cand in candidates {
            // `symlink_metadata`：软链本身存在也算（用户软链过来是很常见的用法）
            if cand.symlink_metadata().is_ok() {
                return Some(std::fs::canonicalize(&cand).unwrap_or(cand));
            }
        }
    }
    None
}

/// 解析"哪些捆绑插件该注入"。
///
/// @param bundled - 随包带的插件目录（`pi/resources.rs::bundled_plugin_dir` 的结果）
/// @param enabled - 用户开关（配置里的名字清单；空 = 一个都不开）
/// @param home - 用户主目录
/// @param cwd - 会话工作目录
/// @returns 每个插件的解析结果（顺序 = `bundled` 顺序）
pub fn resolve(bundled: &[PathBuf], enabled: &[String], home: Option<&Path>, cwd: Option<&Path>) -> Vec<BundledPlugin> {
    let dirs = discovery_dirs(home, cwd);
    bundled
        .iter()
        .filter_map(|dir| {
            let name = dir.file_name()?.to_string_lossy().to_string();
            if !enabled.iter().any(|e| e == &name) {
                return Some(BundledPlugin {
                    name,
                    dir: dir.clone(),
                    inject: false,
                    skipped: Some("设置里关掉了".to_string()),
                });
            }
            // 目录里没有清单或没有入口：**不注入**。pi 对"加载失败的扩展"的处理是
            // 报诊断并 exit(1)（`resource-loader.ts`），所以宁可少一个功能，
            // 也不能让用户开不了会话。
            match read_manifest(dir) {
                None => {
                    return Some(BundledPlugin {
                        name,
                        dir: dir.clone(),
                        inject: false,
                        skipped: Some(format!("缺少 {MANIFEST}（随包分发不完整）")),
                    });
                }
                Some(m) if !m.entry.is_empty() && !dir.join(&m.entry).is_file() => {
                    return Some(BundledPlugin {
                        name,
                        dir: dir.clone(),
                        inject: false,
                        skipped: Some(format!("清单里的入口 {} 不存在", m.entry)),
                    });
                }
                Some(_) => {}
            }
            if let Some(found) = existing_install(&dirs, &name) {
                return Some(BundledPlugin {
                    name,
                    dir: dir.clone(),
                    inject: false,
                    // 这条信息要原样给用户看：两个扩展注册同一个工具名会让 pi **直接退出**，
                    // 不是"多一份"而已
                    skipped: Some(format!(
                        "你自己已经装了同名扩展（{}）；再注入一份会让 pi 因工具名冲突而退出，所以跳过",
                        found.display()
                    )),
                });
            }
            Some(BundledPlugin {
                name,
                dir: dir.clone(),
                inject: true,
                skipped: None,
            })
        })
        .collect()
}

/// 只要"该注入的那些目录"（`spawn` 路径用）。
///
/// @param bundled - 随包带的插件目录
/// @returns 目录清单
pub fn enabled_plugin_dirs(bundled: &[PathBuf]) -> Vec<PathBuf> {
    let enabled = crate::config::app::perf_config_load().bundled_plugins;
    resolve(bundled, &enabled, home_dir().as_deref(), None)
        .into_iter()
        .filter(|p| p.inject)
        .map(|p| p.dir)
        .collect()
}

/// 用户主目录（`HOME` / `USERPROFILE`）。
///
/// @returns 主目录；拿不到返回 None（此时只查项目级目录）
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个假的插件目录（清单 + 入口，与随包分发的形态一致）。
    fn plugin_dir(root: &Path, name: &str) -> PathBuf {
        let dir = root.join("pi-plugins").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.js"), "export default function () {}\n").unwrap();
        std::fs::write(
            dir.join(MANIFEST),
            format!(r#"{{"name":"{name}","title":"测试插件","entry":"index.js","tools":["{name}_tool"]}}"#),
        )
        .unwrap();
        dir
    }

    #[test]
    fn enabled_plugin_is_injected() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = plugin_dir(&tmp, "pi-ask");
        let out = resolve(std::slice::from_ref(&dir), &["pi-ask".to_string()], None, None);
        assert_eq!(out.len(), 1);
        assert!(out[0].inject);
        assert_eq!(out[0].name, "pi-ask");
        assert_eq!(out[0].dir, dir);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn disabled_plugin_is_not_injected_and_says_why() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-off-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = plugin_dir(&tmp, "pi-ask");
        let out = resolve(&[dir], &[], None, None);
        assert!(!out[0].inject);
        assert!(out[0].skipped.as_deref().unwrap().contains("关掉"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **这条是这一层存在的理由**：用户自己装过同名扩展 → 不能再注入（否则 pi exit(1)）。
    #[test]
    fn user_installed_same_name_blocks_injection() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-dup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let bundled = plugin_dir(&tmp.join("bundled"), "pi-ask");
        let home = tmp.join("home");
        let user_ext = home.join(".pi").join("agent").join("extensions");
        std::fs::create_dir_all(user_ext.join("pi-ask")).unwrap();
        let out = resolve(&[bundled], &["pi-ask".to_string()], Some(&home), None);
        assert!(!out[0].inject, "用户自己装过同名扩展时不该再注入");
        let why = out[0].skipped.clone().unwrap();
        assert!(why.contains("工具名冲突"), "理由要说明白：{why}");
        assert!(why.contains("pi-ask"), "理由要点出是哪个名字：{why}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 项目级发现目录（`<cwd>/.pi/extensions`）同样要挡住。
    #[test]
    fn project_level_install_also_blocks() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-proj-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let bundled = plugin_dir(&tmp.join("bundled"), "pi-ask");
        let cwd = tmp.join("proj");
        std::fs::create_dir_all(cwd.join(".pi").join("extensions").join("pi-ask")).unwrap();
        let out = resolve(&[bundled], &["pi-ask".to_string()], None, Some(&cwd));
        assert!(!out[0].inject);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 清单缺失 / 入口不存在 → **不注入**并说清原因（加载失败的扩展会让 pi exit(1)）。
    #[test]
    fn broken_bundle_is_not_injected_with_a_reason() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-broken-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // 没有清单
        let no_manifest = tmp.join("pi-plugins").join("pi-ask");
        std::fs::create_dir_all(&no_manifest).unwrap();
        // 有清单但入口不在
        let bad_entry = tmp.join("pi-plugins").join("pi-other");
        std::fs::create_dir_all(&bad_entry).unwrap();
        std::fs::write(bad_entry.join(MANIFEST), r#"{"name":"pi-other","entry":"nope.js"}"#).unwrap();

        let out = resolve(
            &[no_manifest, bad_entry],
            &["pi-ask".to_string(), "pi-other".to_string()],
            None,
            None,
        );
        assert!(!out[0].inject, "缺清单的插件不该注入");
        assert!(out[0].skipped.as_deref().unwrap().contains(MANIFEST));
        assert!(!out[1].inject, "入口不存在的插件不该注入");
        assert!(out[1].skipped.as_deref().unwrap().contains("nope.js"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **随包分发必须真的随包**：两个 SKU 的 `bundle.resources` 都要登记插件目录。
    ///
    /// 这条闸门是 2026-10-09 补的：`pi-plugins/` 是 10-06 加进来的，而资源清单里
    /// **从来没登记过它** —— 于是打包产物一个插件都没有，界面上只是"设置里没有捆绑插件"，
    /// 而**在构建机上直接跑那个 .app 会看起来完全正常**（`resources.rs` 的第三候选
    /// `CARGO_MANIFEST_DIR` 正好命中源码树）。这种"打包完全成功、功能静默消失"
    /// 与 `pi-LICENSE.txt` 那次是同一类（docs/15 规矩 4），所以同样用测试钉住。
    ///
    /// 必须用 `**/*`：tauri 用 `glob` crate，`*` **不跨目录分隔符**，
    /// 写成 `resources/pi-plugins/*` 会把 `pi-todo/src/*.ts` 全漏掉（docs/17 §3 第 6 条）。
    #[test]
    fn both_skus_register_the_plugin_directory() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for conf in ["tauri.conf.json", "tauri.full.conf.json"] {
            let raw = std::fs::read_to_string(root.join(conf)).unwrap_or_else(|e| panic!("读不到 {conf}: {e}"));
            let json: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{conf} 不是合法 JSON: {e}"));
            let list = json["bundle"]["resources"]
                .as_array()
                .unwrap_or_else(|| panic!("{conf} 里没有 bundle.resources"));
            let items: Vec<&str> = list.iter().filter_map(|v| v.as_str()).collect();
            assert!(
                items.contains(&"resources/pi-plugins/**/*"),
                "{conf} 的 bundle.resources 没登记插件目录（打包产物会一个插件都没有）：{items:?}"
            );
        }
    }

    /// 默认开关里的每个名字都要**真的在仓库里**，而且清单与入口齐全。
    ///
    /// 少了目录时 `lib.rs::bundled_plugin_dirs` 会静默跳过（filter_map），
    /// 于是"默认开着的插件"在设置页里连一行都不出现 —— 这条把它变成一次红。
    #[test]
    fn every_default_bundled_plugin_is_in_the_repo() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pi-plugins");
        for name in crate::config::app::default_bundled_plugins() {
            let dir = root.join(&name);
            let m = read_manifest(&dir).unwrap_or_else(|| panic!("{name}: 缺少 {MANIFEST}（{}）", dir.display()));
            assert_eq!(m.name, name, "清单里的 name 必须与目录名一致（开关按目录名匹配）");
            assert!(!m.entry.is_empty(), "{name}: 清单没写 entry");
            assert!(dir.join(&m.entry).is_file(), "{name}: 入口 {} 不存在", m.entry);
        }
    }

    /// 清单里的工具名要能被收集出来（限制档位拼 `--tools` 白名单靠它）。
    #[test]
    fn manifest_tools_are_collected_from_enabled_plugins() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-tools-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let dir = plugin_dir(&tmp, "pi-ask");
        let m = read_manifest(&dir).expect("清单应当能读出来");
        assert_eq!(m.title, "测试插件");
        assert_eq!(m.tools, vec!["pi-ask_tool"]);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 单文件形态（`pi-ask.js`）也算"用户装过了"。
    #[test]
    fn single_file_install_counts_as_installed() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let bundled = plugin_dir(&tmp.join("bundled"), "pi-ask");
        let home = tmp.join("home");
        let user_ext = home.join(".pi").join("agent").join("extensions");
        std::fs::create_dir_all(&user_ext).unwrap();
        std::fs::write(user_ext.join("pi-ask.js"), "// 用户自己写的\n").unwrap();
        let out = resolve(&[bundled], &["pi-ask".to_string()], Some(&home), None);
        assert!(!out[0].inject);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 软链（用户的常见用法：把仓库目录软链进发现目录）也要认出来。
    #[test]
    #[cfg(unix)]
    fn symlinked_install_is_detected() {
        let tmp = std::env::temp_dir().join(format!("piggy-plug-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let bundled = plugin_dir(&tmp.join("bundled"), "pi-ask");
        let elsewhere = plugin_dir(&tmp.join("elsewhere"), "pi-ask");
        let home = tmp.join("home");
        let user_ext = home.join(".pi").join("agent").join("extensions");
        std::fs::create_dir_all(&user_ext).unwrap();
        std::os::unix::fs::symlink(&elsewhere, user_ext.join("pi-ask")).unwrap();
        let out = resolve(&[bundled], &["pi-ask".to_string()], Some(&home), None);
        assert!(!out[0].inject, "软链过来的同名扩展也要挡住（realpath 比较）");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
