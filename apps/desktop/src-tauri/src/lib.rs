//! ion's desktop shell. It tells the UI where the daemon is (port and token from `daemon.json`) and opens a few
//! things for it: your mcp.json in your editor (that one file), ion's memory folder and its files (nothing else in the
//! data folder), and sign-in pages in your browser; everything else goes through the daemon's WebSocket API.

use std::path::PathBuf;

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub struct DaemonInfo {
    pub port: u16,
    pub token: String,
}

/// ion's data folder, in the same order as `ionPaths()` in @ion/config:
/// `$ION_HOME/data`, else `$XDG_DATA_HOME/ion`, else `~/.local/share/ion`.
pub fn data_dir(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(home) = set("ION_HOME") {
        return Some(PathBuf::from(home).join("data"));
    }
    if let Some(xdg) = set("XDG_DATA_HOME") {
        return Some(PathBuf::from(xdg).join("ion"));
    }
    set("HOME").map(|h| PathBuf::from(h).join(".local").join("share").join("ion"))
}

/// Your mcp.json, beside the config file, in the same order as `ionPaths()` / `mcpFileOf()` in @ion/config:
/// `$ION_HOME/mcp.json`, else `$XDG_CONFIG_HOME/ion/mcp.json`, else `~/.config/ion/mcp.json`.
pub fn mcp_file(env: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let set = |k: &str| env(k).filter(|v| !v.is_empty());
    if let Some(home) = set("ION_HOME") {
        return Some(PathBuf::from(home).join("mcp.json"));
    }
    let config = set("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| set("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(config.join("ion").join("mcp.json"))
}

/// ion's memory folder (Settings → Memory → Open memory folder), and each Markdown file in it (a row's Open):
/// `<data>/memory` and `<data>/memory/**/*.md`, nothing else there.
pub fn memory_paths(env: impl Fn(&str) -> Option<String>) -> Option<[PathBuf; 2]> {
    let dir = data_dir(env)?.join("memory");
    Some([dir.clone(), dir.join("**").join("*.md")])
}

/// The running daemon's port and token, or None when ion isn't running (no file, or one ion can't read).
pub fn read_daemon_info(dir: &std::path::Path) -> Option<DaemonInfo> {
    let text = std::fs::read_to_string(dir.join("daemon.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// The first letter of your account's name, for the rail's avatar ("Y" when there's none).
pub fn initial_of(name: Option<String>) -> String {
    name.and_then(|n| n.trim().chars().next())
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_else(|| "Y".to_string())
}

#[tauri::command]
fn user_initial() -> String {
    initial_of(std::env::var("USER").ok())
}

#[tauri::command]
fn daemon_info() -> Option<DaemonInfo> {
    read_daemon_info(&data_dir(|k| std::env::var(k).ok())?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // The window may open your mcp.json (Settings → Tools → Open config file) and ion's memory folder and
            // its files (Settings → Memory), nothing else.
            let env = |k: &str| std::env::var(k).ok();
            let mut paths: Vec<PathBuf> = mcp_file(env).into_iter().collect();
            paths.extend(memory_paths(env).into_iter().flatten());
            if !paths.is_empty() {
                use tauri::Manager;
                let allow = paths.iter().map(|p| serde_json::json!({ "path": p })).collect();
                app.add_capability(
                    tauri::ipc::CapabilityBuilder::new("ion-files")
                        .window("main")
                        .permission_scoped("opener:allow-open-path", allow, vec![]),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![daemon_info, user_initial])
        .run(tauri::generate_context!())
        .expect("ion couldn't open its window");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn ion_home_wins_then_xdg_then_home() {
        let all = env(&[("ION_HOME", "/i"), ("XDG_DATA_HOME", "/x"), ("HOME", "/h")]);
        assert_eq!(data_dir(all), Some(PathBuf::from("/i/data")));
        assert_eq!(data_dir(env(&[("XDG_DATA_HOME", "/x"), ("HOME", "/h")])), Some(PathBuf::from("/x/ion")));
        assert_eq!(data_dir(env(&[("HOME", "/h")])), Some(PathBuf::from("/h/.local/share/ion")));
        assert_eq!(data_dir(env(&[("ION_HOME", ""), ("HOME", "/h")])), Some(PathBuf::from("/h/.local/share/ion")));
    }

    #[test]
    fn mcp_file_is_beside_the_config_file() {
        let all = env(&[("ION_HOME", "/i"), ("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")]);
        assert_eq!(mcp_file(all), Some(PathBuf::from("/i/mcp.json")));
        assert_eq!(mcp_file(env(&[("XDG_CONFIG_HOME", "/x"), ("HOME", "/h")])), Some(PathBuf::from("/x/ion/mcp.json")));
        assert_eq!(mcp_file(env(&[("HOME", "/h")])), Some(PathBuf::from("/h/.config/ion/mcp.json")));
        assert_eq!(mcp_file(env(&[])), None);
    }

    #[test]
    fn memory_is_the_data_folders_memory_and_its_files() {
        let [dir, files] = memory_paths(env(&[("ION_HOME", "/i")])).unwrap();
        assert_eq!(dir, PathBuf::from("/i/data/memory"));
        // Task review, 2026-11-22: Markdown files only, not anything else in the folder.
        assert_eq!(files, PathBuf::from("/i/data/memory/**/*.md"));
        assert_eq!(memory_paths(env(&[])), None);
    }

    #[test]
    fn initial_is_the_first_letter_or_y() {
        assert_eq!(initial_of(Some("justin".into())), "J");
        assert_eq!(initial_of(Some("".into())), "Y");
        assert_eq!(initial_of(None), "Y");
    }

    #[test]
    fn reads_port_and_token_and_ignores_the_rest() {
        let dir = std::env::temp_dir().join(format!("ion-desktop-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_daemon_info(&dir), None);
        std::fs::write(dir.join("daemon.json"), r#"{"pid":1,"port":4100,"token":"t"}"#).unwrap();
        assert_eq!(read_daemon_info(&dir), Some(DaemonInfo { port: 4100, token: "t".into() }));
        std::fs::write(dir.join("daemon.json"), "nope").unwrap();
        assert_eq!(read_daemon_info(&dir), None);
    }
}
