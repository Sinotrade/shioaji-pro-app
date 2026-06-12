use tauri::{
    menu::{Menu, MenuItem, MenuItemKind},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

const TRAY_W: f64 = 380.0;
const TRAY_H: f64 = 540.0;

// Toggle the compact tray panel anchored at the tray icon (menu-bar app UX:
// left-click shows quick watchlist/positions, right-click keeps the menu).
fn toggle_tray_panel(app: &tauri::AppHandle, icon_rect: tauri::Rect) {
    if let Some(win) = app.get_webview_window("tray") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            position_tray_panel(&win, icon_rect);
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }
    let win = WebviewWindowBuilder::new(
        app,
        "tray",
        WebviewUrl::App("index.html?popout=traypanel".into()),
    )
    .title("Shioaji Pro")
    .inner_size(TRAY_W, TRAY_H)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build();
    if let Ok(win) = win {
        position_tray_panel(&win, icon_rect);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn position_tray_panel(win: &tauri::WebviewWindow, rect: tauri::Rect) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let (ix, iy, iw, ih) = match (rect.position, rect.size) {
        (tauri::Position::Physical(p), tauri::Size::Physical(s)) => {
            (p.x as f64, p.y as f64, s.width as f64, s.height as f64)
        }
        (tauri::Position::Logical(p), tauri::Size::Logical(s)) => (
            p.x * scale,
            p.y * scale,
            s.width * scale,
            s.height * scale,
        ),
        _ => return,
    };
    let w = TRAY_W * scale;
    let x = (ix + iw / 2.0 - w / 2.0).max(8.0);
    // tray at the top (macOS) → drop below the icon; bottom bars → above
    let monitor_h = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64)
        .unwrap_or(1080.0);
    let y = if iy < monitor_h / 2.0 {
        iy + ih + 6.0
    } else {
        iy - TRAY_H * scale - 6.0
    };
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
}

// Returns `preferred` if it is bindable on 127.0.0.1, otherwise the first
// free port after it (0 if none found within 50). Used to dodge port-8080
// conflicts before spawning the shioaji sidecar.
// Codex CLI subscription auth (~/.codex/auth.json): read for the AI Agent's
// "Codex 訂閱" provider, write back refreshed tokens so the CLI keeps working.
fn codex_auth_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| dirs_next_home().map(|h| h.join(".codex")))?;
    Some(home.join("auth.json"))
}

fn dirs_next_home() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(std::path::PathBuf::from)
}

#[tauri::command]
fn read_codex_auth() -> Result<String, String> {
    let path = codex_auth_path().ok_or("無法取得家目錄")?;
    std::fs::read_to_string(&path)
        .map_err(|e| format!("讀取 {} 失敗：{e}（請先用 codex login 登入）", path.display()))
}

#[tauri::command]
fn write_codex_auth(content: String) -> Result<(), String> {
    let path = codex_auth_path().ok_or("無法取得家目錄")?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn find_free_port(preferred: u16) -> u16 {
    use std::net::TcpListener;
    let bindable = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    if bindable(preferred) {
        return preferred;
    }
    for p in (preferred + 1)..(preferred.saturating_add(50)) {
        if bindable(p) {
            return p;
        }
    }
    0
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // focus the existing window when a second instance launches
            show_main(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![find_free_port, read_codex_auth, write_codex_auth])
        .setup(|app| {
            // ---- tray / menu-bar icon ----
            let show =
                MenuItem::with_id(app, "show", "顯示 Shioaji Pro", true, None::<&str>)?;
            let server =
                MenuItem::with_id(app, "server", "伺服器管理…", true, None::<&str>)?;
            let update =
                MenuItem::with_id(app, "update", "檢查更新…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &server, &update, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Shioaji Pro")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "server" => {
                        show_main(app);
                        let _ = app.emit("open-server-manager", ());
                    }
                    "update" => {
                        show_main(app);
                        let _ = app.emit("check-updates", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        toggle_tray_panel(tray.app_handle(), rect);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
                #[cfg(target_os = "macos")]
                {
                    tray = tray.icon_as_template(false);
                }
            }
            tray.build(app)?;

            // native app menu with a standard "Check for Updates…" entry
            #[cfg(target_os = "macos")]
            {
                let menu = Menu::default(app.handle())?;
                if let Some(MenuItemKind::Submenu(app_menu)) =
                    menu.items()?.into_iter().next()
                {
                    let check = MenuItem::with_id(
                        app,
                        "menu-check-update",
                        "檢查更新…",
                        true,
                        None::<&str>,
                    )?;
                    app_menu.insert(&check, 1)?;
                }
                app.set_menu(menu)?;
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "menu-check-update" {
                show_main(app);
                let _ = app.emit("check-updates", ());
            }
        })
        .on_window_event(|window, event| {
            // closing the main window hides to tray (menu-bar app behaviour)
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // the tray panel hides itself when it loses focus
            if window.label() == "tray" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
