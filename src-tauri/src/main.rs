#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod process;
mod timer;

use std::sync::Arc;
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 主窗口初始尺寸。
/// 高度只是起点：前端 useAutoWindowHeight 会在首帧测内容高度后自行调整。
/// 宽度已计入左侧 152px 导航栏与 16px 间距，保证内容区不比加侧边栏前更窄。
const MAIN_WIDTH: f64 = 960.0;
const MAIN_HEIGHT: f64 = 350.0;

fn main() {
    let app_system = process::AppSystem::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_system.clone())
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("work-tool")
                .inner_size(MAIN_WIDTH, MAIN_HEIGHT)
                .center()
                .build()
                .map_err(|e| format!("创建主窗口失败: {}", e))?;

            process::spawn_monitor(app.handle().clone(), Arc::clone(&app_system));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            process::get_app_list,
            process::kill_app,
            process::get_app_process_details,
            process::initialize_app,
            process::get_app_config,
            process::save_app_config,
            timer::get_all_tasks,
            timer::add_task,
            timer::delete_task,
            timer::clear_all_tasks,
            timer::exists_task,
            timer::next_task,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}