use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const DEFAULT_GATEWAY_ADDR: &str = "127.0.0.1:10087";

struct SidecarState(Mutex<Option<CommandChild>>);

fn gateway_addr() -> String {
    std::env::var("CODEARTS_ADDR").unwrap_or_else(|_| DEFAULT_GATEWAY_ADDR.to_string())
}

fn gateway_url(addr: &str) -> String {
    format!("http://{}/", addr)
}

fn is_gateway_healthy(addr: &str) -> bool {
    let Ok(sock_addr) = addr.parse::<SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&sock_addr, Duration::from_millis(350)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(450)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(450)));

    let req = format!(
        "GET /health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        addr
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
}

fn open_in_system_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<SidecarState>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    }
}

fn notify_boot_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(encoded) = serde_json::to_string(message) {
            let script = format!(
                "window.__setBootError && window.__setBootError({});",
                encoded
            );
            let _ = window.eval(&script);
        }
    }
}

fn spawn_and_wait_gateway(app: AppHandle) {
    let addr = gateway_addr();
    let target_url = gateway_url(&addr);
    let (host, port) = addr
        .rsplit_once(':')
        .map(|(h, p)| (h.to_string(), p.to_string()))
        .unwrap_or_else(|| ("127.0.0.1".to_string(), "10087".to_string()));

    let reused_existing = is_gateway_healthy(&addr);
    if !reused_existing {
        match app.shell().sidecar("codearts-gateway") {
            Ok(mut cmd) => {
                cmd = cmd
                    .env("CODEARTS_HOST", &host)
                    .env("CODEARTS_PORT", &port)
                    .env("CODEARTS_DESKTOP_CLIENT", "1");

                // Store state & snapshots inside user-writable AppData instead of read-only Program Files.
                if let Ok(data_dir) = app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&data_dir);
                    let state_file = data_dir.join("codearts2api-data.json");
                    let switch_dir = data_dir.join("switch-data");
                    let _ = std::fs::create_dir_all(&switch_dir);
                    cmd = cmd
                        .env("CODEARTS_DATA_PATH", state_file.to_string_lossy().as_ref())
                        .env(
                            "CODEARTS_SWITCH_DATA_DIR",
                            switch_dir.to_string_lossy().as_ref(),
                        );
                }

                match cmd.spawn() {
                    Ok((mut rx, child)) => {
                        if let Some(state) = app.try_state::<SidecarState>() {
                            if let Ok(mut guard) = state.0.lock() {
                                *guard = Some(child);
                            }
                        }
                        // Drain sidecar stdout/stderr so pipes never stall the Go gateway.
                        tauri::async_runtime::spawn(async move {
                            while let Some(_event) = rx.recv().await {}
                        });
                    }
                    Err(err) => {
                        notify_boot_error(
                            &app,
                            &format!("无法拉起内置 Go 网关核心 (codearts-gateway)：{}", err),
                        );
                        return;
                    }
                }
            }
            Err(err) => {
                notify_boot_error(
                    &app,
                    &format!(
                        "未找到打包的 Go 网关核心 (binaries/codearts-gateway)：{}。\n请运行 scripts/build-tauri-windows.ps1 重新构建。",
                        err
                    ),
                );
                return;
            }
        }
    }

    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(18);
        while Instant::now() < deadline {
            if is_gateway_healthy(&addr) {
                if let Some(window) = app.get_webview_window("main") {
                    if let Ok(parsed) = Url::parse(&target_url) {
                        let _ = window.navigate(parsed);
                    }
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(200));
        }

        notify_boot_error(
            &app,
            &format!(
                "等待内置网关 http://{}/health 超时（18秒）。\n请检查端口 {} 是否被其他程序占用，或确认 Go 网关可执行文件运行正常。",
                addr, addr
            ),
        );
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let show_item =
                MenuItemBuilder::with_id("show", "显示码道 Switch 主窗口").build(app)?;
            let browser_item =
                MenuItemBuilder::with_id("open_browser", "在浏览器中打开控制台").build(app)?;
            let quit_item =
                MenuItemBuilder::with_id("quit", "退出码道 Switch（关闭网关）").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &browser_item, &quit_item])
                .build()?;

            let mut tray_builder = TrayIconBuilder::with_id("codearts-switch-tray")
                .menu(&menu)
                .tooltip("码道 Switch — CodeArts 智能体网关")
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "open_browser" => {
                        let url = gateway_url(&gateway_addr());
                        open_in_system_browser(&url);
                    }
                    "quit" => {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder.build(app)?;

            spawn_and_wait_gateway(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building 码道 Switch desktop client");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            kill_sidecar(app_handle);
        }
    });
}
