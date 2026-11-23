//! ion's desktop shell. It tells the UI where the daemon is (port and token from `daemon.json`), starts the daemon
//! when it isn't running and the shell can find it, and opens a few things for it: your mcp.json in your editor (that
//! one file), ion's memory folder and its files (nothing else in the data folder), sign-in pages in your browser, and
//! the system's folder picker; everything else goes through the daemon's WebSocket API.

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

/// The daemon this app starts when ion isn't running (Plan 21 audit, 2026-11-23: the app opened on "ion daemon
/// start"): `$ION_DAEMON_BIN`, else the one built beside this app in ion's repo (`apps/daemon/dist/main.js`), when
/// it's there; None otherwise (the app then shows the command).
pub fn daemon_script(env: impl Fn(&str) -> Option<String>, built: &std::path::Path) -> Option<PathBuf> {
    if let Some(bin) = env("ION_DAEMON_BIN").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(bin));
    }
    built.is_file().then(|| built.to_path_buf())
}

/// How the daemon is started: through your login shell, so it has your PATH (an app opened from the Finder gets a
/// short one, and the daemon finds your agents and `node` on it): `<shell> -l -c 'exec node "$0"' <script>`.
pub fn launch_args(env: impl Fn(&str) -> Option<String>, script: &std::path::Path) -> (String, Vec<String>) {
    let shell = env("SHELL").filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".to_string());
    let args = vec!["-l".into(), "-c".into(), "exec node \"$0\"".into(), script.display().to_string()];
    (shell, args)
}

/// The daemon built in ion's repo, beside this app's source (a development build).
const BUILT_DAEMON: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../daemon/dist/main.js");

/// Starts the daemon in the background, its output in `<data>/daemon.log`; false when there's none to start.
#[tauri::command]
fn start_daemon() -> bool {
    use std::os::unix::process::CommandExt;
    let env = |k: &str| std::env::var(k).ok();
    let (Some(script), Some(data)) = (daemon_script(env, std::path::Path::new(BUILT_DAEMON)), data_dir(env)) else {
        return false;
    };
    if std::fs::create_dir_all(&data).is_err() {
        return false;
    }
    let Ok(log) = std::fs::OpenOptions::new().create(true).append(true).open(data.join("daemon.log")) else {
        return false;
    };
    let Ok(err) = log.try_clone() else { return false };
    let (shell, args) = launch_args(env, &script);
    std::process::Command::new(shell)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err)
        // Its own process group: closing the app doesn't stop ion.
        .process_group(0)
        .spawn()
        .is_ok()
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
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![daemon_info, user_initial, start_daemon])
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

    // Plan 21 audit, 2026-11-23: the app opened on "ion isn't running. Start it with: ion daemon start".
    #[test]
    fn starts_the_daemon_named_else_the_one_built_beside_it() {
        let built = std::env::temp_dir().join(format!("ion-built-{}.js", std::process::id()));
        assert_eq!(daemon_script(env(&[("ION_DAEMON_BIN", "/x/main.js")]), &built), Some(PathBuf::from("/x/main.js")));
        assert_eq!(daemon_script(env(&[]), &built), None);
        std::fs::write(&built, "").unwrap();
        assert_eq!(daemon_script(env(&[]), &built), Some(built.clone()));
        std::fs::remove_file(&built).unwrap();
    }

    #[test]
    fn starts_it_through_your_login_shell() {
        let script = PathBuf::from("/repo/apps/daemon/dist/main.js");
        let (shell, args) = launch_args(env(&[("SHELL", "/bin/bash")]), &script);
        assert_eq!(shell, "/bin/bash");
        assert_eq!(args, vec!["-l", "-c", "exec node \"$0\"", "/repo/apps/daemon/dist/main.js"]);
        assert_eq!(launch_args(env(&[]), &script).0, "/bin/zsh");
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
