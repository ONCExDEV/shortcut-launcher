#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clip;
mod shell;
mod store;

use std::path::PathBuf;
use store::{Loaded, Store};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

const STATE_FLAGS: StateFlags = StateFlags::SIZE.union(StateFlags::POSITION);

/// The data folder. `SHORTCUT_LAUNCHER_DATA` overrides it (portable use and testing).
fn store(app: &AppHandle) -> Result<Store, String> {
    let dir = match std::env::var_os("SHORTCUT_LAUNCHER_DATA") {
        Some(custom) => PathBuf::from(custom),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    Store::open(dir)
}

/// Brings the window back to the front, re-centering it if it ended up off-screen.
fn show_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if let (Ok(pos), Ok(monitors)) = (w.outer_position(), w.available_monitors()) {
        let on_screen = monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            pos.x >= p.x - 50 && pos.y >= p.y - 50 && pos.x < p.x + s.width as i32 - 100 && pos.y < p.y + s.height as i32 - 100
        });
        if !on_screen {
            let _ = w.center();
        }
    }
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit("launcher-shown", ());
}

fn toggle_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) && !w.is_minimized().unwrap_or(false) {
        hide_window(app.clone());
    } else {
        show_window(app);
    }
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    let _ = app.save_window_state(STATE_FLAGS);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

#[tauri::command]
fn load_data(app: AppHandle) -> Result<Loaded, String> {
    Ok(store(&app)?.load())
}

#[tauri::command]
fn save_data(app: AppHandle, json: String) -> Result<(), String> {
    store(&app)?.save(&json)
}

#[tauri::command]
fn export_backup(app: AppHandle, path: String) -> Result<(), String> {
    store(&app)?.export(std::path::Path::new(&path))
}

#[tauri::command]
fn import_backup(app: AppHandle, path: String) -> Result<String, String> {
    store(&app)?.import(std::path::Path::new(&path))
}

#[tauri::command]
fn log_message(app: AppHandle, message: String) {
    if let Ok(s) = store(&app) {
        s.log(&format!("ui: {message}"));
    }
}

#[tauri::command]
fn open_data_folder(app: AppHandle) -> Result<(), String> {
    let s = store(&app)?;
    shell::reveal(s.dir().to_str().ok_or("Invalid data folder path")?)
}

#[tauri::command]
fn launch(target: String, args: String, admin: bool) -> Result<(), String> {
    shell::launch(&target, &args, admin)
}

// A plain (non-async) command runs on the main thread, which the Properties window needs to stay open.
#[tauri::command]
fn show_properties(path: String) -> Result<(), String> {
    shell::show_properties(&path)
}

#[tauri::command]
fn reveal(target: String) -> Result<(), String> {
    shell::reveal(&target)
}

#[tauri::command]
async fn get_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || shell::icon_data_url(&path)).await.ok().flatten()
}

#[tauri::command]
fn desktop_shortcuts() -> Vec<shell::DesktopEntry> {
    shell::desktop_shortcuts()
}

#[tauri::command]
async fn list_folder(folder: String) -> Vec<shell::DesktopEntry> {
    tauri::async_runtime::spawn_blocking(move || shell::folder_entries(&folder)).await.unwrap_or_default()
}

#[tauri::command]
async fn missing_paths(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || shell::missing_paths(&paths)).await.unwrap_or_default()
}

#[tauri::command]
async fn find_in_folder(folder: String, names: Vec<String>) -> std::collections::HashMap<String, String> {
    tauri::async_runtime::spawn_blocking(move || shell::find_in_folder(&folder, &names)).await.unwrap_or_default()
}

#[tauri::command]
async fn place_in_folder(app: AppHandle, folder: String, items: Vec<shell::PlaceRequest>) -> Vec<shell::Placed> {
    let result = tauri::async_runtime::spawn_blocking(move || shell::place_in_folder(&folder, &items))
        .await
        .unwrap_or_default();
    if let Ok(s) = store(&app) {
        let ok = result.iter().filter(|r| r.error.is_none() && r.action != "kept").count();
        let failed = result.iter().filter(|r| r.error.is_some()).count();
        if ok > 0 || failed > 0 {
            s.log(&format!("place: {ok} shortcut file(s) saved in the shortcuts folder, {failed} failed"));
        }
    }
    result
}

#[tauri::command]
async fn trash_shortcut_files(app: AppHandle, folder: String, paths: Vec<String>) -> Result<Vec<shell::Trashed>, String> {
    let root = store(&app)?.dir().join("removed-shortcuts");
    let logger = store(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || shell::trash_shortcut_files(&folder, &root, &paths))
        .await
        .map_err(|e| e.to_string())?;
    let n = result.iter().filter(|t| t.holding.is_some()).count();
    if n > 0 {
        logger.log(&format!("remove: {n} shortcut file(s) taken out of the shortcuts folder (kept 30 days in removed-shortcuts)"));
    }
    Ok(result)
}

#[tauri::command]
async fn restore_shortcut_files(items: Vec<shell::Trashed>) -> Vec<shell::Restored> {
    tauri::async_runtime::spawn_blocking(move || shell::restore_shortcut_files(&items)).await.unwrap_or_default()
}

#[tauri::command]
async fn copy_shortcut_files(items: Vec<shell::PlaceRequest>, text: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let paths = shell::materialize_shortcuts(&items);
        if paths.is_empty() {
            return Err("There is nothing to copy".to_string());
        }
        clip::set_files(&paths, &text)?;
        Ok(paths)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn drag_out(items: Vec<shell::PlaceRequest>) -> Result<(), String> {
    // Runs on the main thread, where the drag has to start while the mouse button is still down.
    let (folder, names) = shell::stage_for_drag(&items)?;
    clip::drag_files(&folder, &names)
}


#[tauri::command]
async fn clipboard_files() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(clip::get_files).await.unwrap_or_default()
}

#[tauri::command]
async fn start_apps() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(shell::start_apps).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn create_desktop_shortcut() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(shell::create_desktop_shortcut).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_autostart() -> bool {
    shell::autostart_enabled()
}

#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    shell::set_autostart(enabled)
}

#[tauri::command]
fn set_hotkey(app: AppHandle, hotkey: String) -> Result<(), String> {
    let shortcut: Shortcut = hotkey.parse().map_err(|_| format!("\"{hotkey}\" is not a valid shortcut"))?;
    let keys = app.global_shortcut();
    let _ = keys.unregister_all();
    keys.on_shortcut(shortcut, |app, _, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_window(app);
        }
    })
    .map_err(|_| format!("\"{hotkey}\" is already used by another app"))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    let _ = app.save_window_state(STATE_FLAGS);
    app.exit(0);
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open launcher", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut tray = TrayIconBuilder::with_id("tray")
        .tooltip("Shortcut Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_window(app),
            "quit" => quit_app(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    let mut builder = tauri::Builder::default();
    // A custom data folder means a separate (portable or test) copy, which may run next to the normal one.
    if std::env::var_os("SHORTCUT_LAUNCHER_DATA").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show_window(app)));
    }
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_state_flags(STATE_FLAGS).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_data,
            save_data,
            export_backup,
            import_backup,
            log_message,
            open_data_folder,
            launch,
            reveal,
            show_properties,
            get_icon,
            desktop_shortcuts,
            start_apps,
            list_folder,
            missing_paths,
            find_in_folder,
            place_in_folder,
            trash_shortcut_files,
            restore_shortcut_files,
            copy_shortcut_files,
            clipboard_files,
            drag_out,
            create_desktop_shortcut,
            get_autostart,
            set_autostart,
            set_hotkey,
            hide_window,
            quit_app,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Err(e) = build_tray(&handle) {
                if let Ok(s) = store(&handle) {
                    s.log(&format!("tray: could not be created: {e}"));
                }
            }
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            } else {
                show_window(&handle);
            }
            if let Ok(s) = store(&handle) {
                let root = s.dir().join("removed-shortcuts");
                std::thread::spawn(move || shell::purge_removed(&root, 30));
            }
            // Keep the "start with Windows" entry pointing at the current location of this exe.
            // (Not for a portable or test copy with its own data folder, which must not touch the registry.)
            if std::env::var_os("SHORTCUT_LAUNCHER_DATA").is_none() {
                std::thread::spawn(|| {
                    if shell::autostart_enabled() {
                        let _ = shell::set_autostart(true);
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("Shortcut Launcher failed to start: {e}");
    }
}
