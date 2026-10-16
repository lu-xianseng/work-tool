#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chat;
mod process;
mod timer;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 主窗口初始尺寸。
/// 高度只是起点：非对话页前端 useAutoWindowHeight 会在首帧测内容高度后自行调整；
/// AI 对话页激活时高度自适应暂停，因此初始高度就是对话页的实际体验高度，
/// 取 680 兼顾 1080p 与 1366×768（含标题栏后不超出 768 屏可用区）。
/// 宽度已计入左侧 152px 导航栏与 16px 间距；1200 下对话消息区约 790px，
/// 代码块/长文本无需横向滚动即可完整阅读。
const MAIN_WIDTH: f64 = 1200.0;
const MAIN_HEIGHT: f64 = 680.0;

/// 安装目录 = 可执行文件所在目录（NSIS 安装包把 exe 装在安装目录根）。
fn install_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 把旧版路径下的数据一次性迁移到安装目录 data/ 下：
/// - AI 对话：%APPDATA%\com.work-tool.app\{chat_data.json, ai_settings.json}
/// - 定时任务：%APPDATA%\WorkTool\db\data.db
/// 目标文件已存在时不覆盖（以当前版本的数据为准）。
fn migrate_legacy_data() {
    let target = install_dir().join("data");
    let Ok(ap) = std::env::var("APPDATA") else {
        return;
    };
    let ap = PathBuf::from(ap);
    let candidates = [
        (
            ap.join("com.work-tool.app").join("chat_data.json"),
            target.join("chat_data.json"),
        ),
        (
            ap.join("com.work-tool.app").join("ai_settings.json"),
            target.join("ai_settings.json"),
        ),
        (
            ap.join("WorkTool").join("db").join("data.db"),
            target.join("data.db"),
        ),
    ];
    for (src, dst) in candidates {
        if src.exists() && !dst.exists() {
            if let Some(parent) = dst.parent() {
                if fs::create_dir_all(parent).is_ok() {
                    let _ = fs::copy(&src, &dst);
                }
            }
        }
    }
}

fn main() {
    let app_system = process::AppSystem::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_system.clone())
        .setup(move |app| {
            // 旧版（开发期 app_data_dir / config_dir）数据迁移到安装目录 data/
            migrate_legacy_data();

            // AI 对话数据存储（安装目录 data/ 下 JSON），需在窗口创建前就绪
            let chat_store = chat::ChatStore::new()
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(chat_store);

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
            chat::get_ai_models,
            chat::save_ai_models,
            chat::list_conversations,
            chat::create_conversation,
            chat::get_active_conversation_id,
            chat::set_active_conversation,
            chat::set_conversation_model,
            chat::rename_conversation,
            chat::delete_conversation,
            chat::get_conversation,
            chat::add_message,
            chat::stream_chat,
            chat::generate_conversation_title,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}