#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    // 极简日志：输出到 stderr，release 窗口不弹出控制台
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    let action = commands::parse_action_arg();
    log::info!("确认窗口启动, action={}", action);

    let title = if action == "shutdown" {
        "定时关机"
    } else {
        "定时重启"
    };

    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "confirm",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title(title)
            .inner_size(360.0, 240.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .center()
            .build()
            .map_err(|e| format!("创建确认窗口失败: {}", e))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_confirm_action,
            commands::execute_action,
            commands::window_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
