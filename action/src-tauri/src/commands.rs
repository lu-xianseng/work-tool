//! 确认窗口专用的后端命令
//!
//! 只保留三件事：
//! 1. 告诉前端当前是 shutdown 还是 reboot；
//! 2. 执行 shutdown /r 或 /s；
//! 3. 关闭窗口（即取消操作）。

/// 创建子进程时不弹出控制台窗口，避免 GUI 程序调用 shutdown 时黑窗闪烁
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;

/// 构造一个不会弹出控制台窗口的 Command
fn silent_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// 按 Windows 控制台 OEM 代码页解码子进程输出（中文系统为 GBK/936）
#[cfg(windows)]
fn decode_console_output(bytes: &[u8]) -> String {
    const CP_OEMCP: u32 = 1;
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const u8,
            len_multi_byte: i32,
            wide_char_str: *mut u16,
            cch_wide_char: i32,
        ) -> i32;
    }

    if bytes.is_empty() {
        return String::new();
    }

    unsafe {
        let len = MultiByteToWideChar(
            CP_OEMCP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if len <= 0 {
            return String::from_utf8_lossy(bytes).trim().to_string();
        }
        let mut buf: Vec<u16> = vec![0; len as usize];
        let written = MultiByteToWideChar(
            CP_OEMCP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            buf.as_mut_ptr(),
            len,
        );
        if written <= 0 {
            return String::from_utf8_lossy(bytes).trim().to_string();
        }
        buf.truncate(written as usize);
        std::ffi::OsString::from_wide(&buf)
            .to_string_lossy()
            .trim()
            .to_string()
    }
}

#[cfg(not(windows))]
fn decode_console_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

/// 解析命令行参数 `--action shutdown|reboot`
///
/// 计划任务拉起时一定会带参数；无参数（如本地开发调试）时默认 shutdown，
/// 方便直接 `tauri dev` 预览界面。
pub fn parse_action_arg() -> &'static str {
    let args: Vec<String> = std::env::args().collect();
    for i in 0..args.len().saturating_sub(1) {
        if args[i] == "--action" {
            return match args[i + 1].as_str() {
                "shutdown" => "shutdown",
                "reboot" => "reboot",
                other => {
                    log::warn!("未知 --action 参数: {}, 兜底为 shutdown", other);
                    "shutdown"
                }
            };
        }
    }
    std::process::exit(0)
}

/// 前端查询当前确认动作
#[tauri::command]
pub fn get_confirm_action() -> &'static str {
    parse_action_arg()
}

/// 执行关机或重启（/t 0 立即执行，/f 强制关闭所有程序）
#[tauri::command]
pub fn execute_action(action: String) -> Result<(), String> {
    log::info!("执行动作: {}", action);

    let flag = match action.as_str() {
        "shutdown" => "/s",
        "reboot" => "/r",
        other => return Err(format!("未知动作: {}", other)),
    };

    let output = silent_command("shutdown")
        .args(&[flag, "/f", "/t", "0"])
        .output()
        .map_err(|e| format!("执行 shutdown 命令失败: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let err = decode_console_output(&output.stderr);
        Err(format!("shutdown 命令返回错误: {}", err))
    }
}

/// 关闭窗口（用户点"取消"或右上角 ✕ 时调用）
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    log::info!("用户取消操作, 关闭窗口");
    window.close().map_err(|e| e.to_string())
}
