//! 定时重启 / 关机模块
//!
//! 集成自 Lorien Timer：任务的增删查、循环规则与「下一次执行时间」的计算保持原有逻辑。
//! 触发方式按当前需求改为——计划任务到点时拉起一个外部执行程序，并以
//! `--action reboot` / `--action shutdown` 告知要执行的动作，
//! 倒计时提示与真正的关机动作都由该程序负责。
//! 原实现是拉起自身、在自己的窗口里倒计时，这里已不再需要，
//! 因此原项目的确认弹窗模式（parse_action_arg / execute_action）没有一并移植。
//!
//! 任务注册在 Windows 任务计划程序（schtasks）中，本程序退出后仍会按时触发；
//! SQLite 只是界面展示用的任务清单副本，两边必须同步增删，否则会出现
//! 「界面上没有、系统里却还会触发」的孤儿任务。

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{Datelike, Local, NaiveDate, TimeZone, Weekday};
use rusqlite::{Connection, OptionalExtension, Result as SqlResult};

/// 计划任务到点时拉起的执行程序文件名。
///
/// 该程序由外部单独提供、随本应用一起分发，约定放在 exe 同级目录
/// （与 apps.ini 的定位方式一致）。触发时它只收到一个参数：`reboot` 或 `shutdown`。
/// 换名字时只改这一处即可。
const ACTION_PROGRAM_NAME: &str = "action.exe";

/// 计划任务名前缀。用独立前缀，避免与单独安装的 Lorien Timer 抢占同名任务。
const TASK_NAME_PREFIX: &str = "WORKTOOL";

// ==================== Windows 子进程辅助 ====================

/// 创建子进程时不弹出控制台窗口：GUI 程序调用 schtasks 这类控制台程序会闪黑窗
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 构造一个不会弹出控制台窗口的 Command
fn silent_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// 按 Windows 控制台 OEM 代码页解码子进程输出。
///
/// schtasks 输出的是控制台代码页（中文系统为 936/GBK），直接按 UTF-8 解码会得到乱码。
/// 这里用 CP_OEMCP 让系统自行解析当前代码页，解码失败时回退到 UTF-8 lossy，
/// 保证不会因编码问题中断流程。
#[cfg(windows)]
fn decode_console_output(bytes: &[u8]) -> String {
    const CP_OEMCP: u32 = 1;
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;

    #[link(name = "kernel32")]
    // Rust 2024 edition 要求 extern 块显式标注 unsafe
    unsafe extern "system" {
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
        // 第一次调用仅取所需缓冲区长度
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
        use std::os::windows::ffi::OsStringExt;
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

// ==================== 时间计算 ====================

/// 中文星期 → ISO 序号（1=周一 … 7=周日）
fn weekday_index(day: &str) -> Option<u32> {
    match day {
        "周一" | "星期一" => Some(1),
        "周二" | "星期二" => Some(2),
        "周三" | "星期三" => Some(3),
        "周四" | "星期四" => Some(4),
        "周五" | "星期五" => Some(5),
        "周六" | "星期六" => Some(6),
        "周日" | "星期日" | "星期天" => Some(7),
        _ => None,
    }
}

fn weekday_of(day: &str) -> Option<Weekday> {
    Some(match weekday_index(day)? {
        1 => Weekday::Mon,
        2 => Weekday::Tue,
        3 => Weekday::Wed,
        4 => Weekday::Thu,
        5 => Weekday::Fri,
        6 => Weekday::Sat,
        _ => Weekday::Sun,
    })
}

/// schtasks 的 `/d` 参数要求英文缩写
fn schtasks_weekday(day: &str) -> Option<&'static str> {
    Some(match weekday_index(day)? {
        1 => "MON",
        2 => "TUE",
        3 => "WED",
        4 => "THU",
        5 => "FRI",
        6 => "SAT",
        _ => "SUN",
    })
}

/// 「12日」/「12」/「12 日」→ 12
fn month_day(day: &str) -> Option<u32> {
    day.trim()
        .trim_end_matches(['日', ' '])
        .trim()
        .parse()
        .ok()
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 计算任务的下一次执行时间（epoch 秒），算不出或已无未来触发点时返回 None。
///
/// loop_type: "1"=每天 "2"=每周(day=周一..周日) "3"=每月(day=N日，小月自动钳制到月末)
fn next_execute_epoch(loop_type: &str, day: &str, hour: i32, minute: i32) -> Option<i64> {
    let now = Local::now();
    let at = |d: NaiveDate| -> Option<chrono::DateTime<Local>> {
        Local
            .from_local_datetime(&d.and_hms_opt(hour as u32, minute as u32, 0)?)
            .single()
    };

    let target: NaiveDate = match loop_type {
        "2" => {
            let wd = weekday_of(day)?;
            let mut date = now.date_naive();
            let mut found = None;
            // 一周 7 天，多留一轮容错；当天时间点已过时自然落到下周
            for _ in 0..8 {
                if date.weekday() == wd {
                    if let Some(t) = at(date) {
                        if t > now {
                            found = Some(date);
                            break;
                        }
                    }
                }
                date = date.succ_opt()?;
            }
            found?
        }
        "3" => {
            let dom = month_day(day)?;
            let (mut y, mut m) = (now.year(), now.month());
            let mut found = None;
            // 最多向后找两年多，足够覆盖「2 月 30 日」这类只能靠钳制命中的情况
            for _ in 0..25 {
                let eff = dom.min(days_in_month(y, m));
                if let Some(d) = NaiveDate::from_ymd_opt(y, m, eff) {
                    if let Some(t) = at(d) {
                        if t > now {
                            found = Some(d);
                            break;
                        }
                    }
                }
                if m == 12 {
                    y += 1;
                    m = 1;
                } else {
                    m += 1;
                }
            }
            found?
        }
        _ => {
            // 每天：今天还没到点就排今天，否则排明天
            let date = now.date_naive();
            match at(date) {
                Some(t) if t > now => date,
                _ => date.succ_opt()?,
            }
        }
    };

    at(target).filter(|t| *t > now).map(|t| t.timestamp())
}

// ==================== 计划任务命名 ====================

/// 循环规则编码，用于区分同名时间点下的不同循环，避免互相覆盖
fn task_code(loop_type: &str, day: &str) -> String {
    match loop_type {
        "1" => "D0".to_string(),
        "2" => format!("W{}", weekday_index(day).unwrap_or(0)),
        "3" => format!("M{:02}", month_day(day).unwrap_or(0)),
        _ => "X0".to_string(),
    }
}

fn make_task_name(action: &str, hour: i32, minute: i32, loop_type: &str, day: &str) -> String {
    format!(
        "{}-{}-{:02}{:02}-{}",
        TASK_NAME_PREFIX,
        action,
        hour,
        minute,
        task_code(loop_type, day)
    )
}

/// 执行程序的定位方式与 apps.ini 一致：exe 同级目录，便于随安装包分发
fn action_program_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join(ACTION_PROGRAM_NAME)))
        .unwrap_or_else(|| PathBuf::from(ACTION_PROGRAM_NAME))
}

/// 拼装交给计划任务的完整命令行：`"C:\...\timer.exe" --action shutdown`。
///
/// 动作走 `--action` 具名开关而非裸位置参数，这样执行程序可以自行区分
/// 「带 --action 的定时触发」与其他调用方式，也不会把未来的附加参数误当成动作。
/// 路径必须整体加引号：schtasks 的 /tr 是当作单条命令行解析的，
/// 程序装在 `C:\Program Files` 这类含空格目录时，不加引号会被从空格处截断。
fn action_command_line(action: &str) -> String {
    format!("\"{}\" --action {}", action_program_path().display(), action)
}

// ==================== 本地任务清单（SQLite） ====================

/// 一条定时任务。字段命名与前端 TS 接口保持一致（下划线形式，serde 默认不转换）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskItem {
    pub id: i64,
    /// reboot / shutdown
    pub action: String,
    pub hour: i32,
    pub minute: i32,
    /// "1"=每天 "2"=每周 "3"=每月
    pub loop_type: String,
    /// 每周为「周一」…，每月为「12日」，每天为空串
    pub day: String,
}

/// 增删类命令的统一返回。
///
/// schtasks 与数据库是两套独立状态，其中一边失败时界面清单会和系统实际情况不一致
/// （尤其是「数据库删了、计划任务还在」会导致任务照常触发却无法在界面上取消）。
/// 这类问题不致命、不该中断操作，但必须告知用户，所以用 warning 带回而不是静默忽略。
#[derive(Debug, serde::Serialize)]
pub struct TaskOutcome {
    /// 本次受影响的数据库记录数
    pub affected: usize,
    /// 非致命问题描述，空串表示一切正常
    pub warning: String,
}

/// 最近一个将要触发的任务。返回 None 表示没有任何任务。
#[derive(Debug, Clone, serde::Serialize)]
pub struct NextTask {
    /// 下一次执行时刻的 epoch 秒。前端据此本地推进倒计时，无需每秒发 IPC。
    pub epoch: i64,
    pub action: String,
}

fn db_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("WorkTool");
    path.push("db");
    let _ = fs::create_dir_all(&path);
    path.join("data.db")
}

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库操作失败: {}", e)
}

/// 打开连接并确保表结构存在。
/// CREATE TABLE IF NOT EXISTS 幂等，因此不需要在启动钩子里单独做一次初始化。
fn open() -> Result<Connection, String> {
    let conn = Connection::open(db_path()).map_err(db_err)?;
    // 多个命令可能短暂并发，给一个等待窗口，避免直接报 database is locked
    conn.busy_timeout(Duration::from_secs(3)).map_err(db_err)?;
    conn.execute(
        r#"CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            hour INTEGER NOT NULL,
            minute INTEGER NOT NULL,
            loop_type TEXT NOT NULL,
            day TEXT
        )"#,
        [],
    )
    .map_err(db_err)?;
    Ok(conn)
}

fn read_task(row: &rusqlite::Row) -> SqlResult<TaskItem> {
    Ok(TaskItem {
        id: row.get(0)?,
        action: row.get(1)?,
        hour: row.get(2)?,
        minute: row.get(3)?,
        loop_type: row.get(4)?,
        // day 允许 NULL（每天循环不写日期），读出来统一成空串，前端展示为「-」
        day: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
    })
}

fn all_tasks(conn: &Connection) -> SqlResult<Vec<TaskItem>> {
    let mut stmt =
        conn.prepare("SELECT id, action, hour, minute, loop_type, day FROM tasks ORDER BY id")?;
    let rows = stmt.query_map([], read_task)?;
    rows.collect()
}

fn task_by_id(conn: &Connection, id: i64) -> SqlResult<Option<TaskItem>> {
    let mut stmt = conn
        .prepare("SELECT id, action, hour, minute, loop_type, day FROM tasks WHERE id = ?1")?;
    stmt.query_row(rusqlite::params![id], read_task).optional()
}

// ==================== Windows 计划任务 ====================

/// 创建 Windows 计划任务，触发时拉起外部执行程序并以 `--action` 传入动作
fn create_windows_task(
    task_name: &str,
    hour: i32,
    minute: i32,
    loop_type: &str,
    day: &str,
    action: &str,
) -> Result<(), String> {
    let cmd = action_command_line(action);

    let sc_type = match loop_type {
        "1" => "DAILY",
        "2" => "WEEKLY",
        "3" => "MONTHLY",
        _ => "DAILY",
    };

    // 每周 / 每月必须带上日期参数，否则 schtasks 会创建失败
    let mut args: Vec<String> = vec![
        "/create".to_string(),
        "/tn".to_string(),
        task_name.to_string(),
        "/tr".to_string(),
        cmd,
        "/sc".to_string(),
        sc_type.to_string(),
        "/st".to_string(),
        format!("{:02}:{:02}:00", hour, minute),
    ];
    match loop_type {
        "2" => {
            let d = schtasks_weekday(day).ok_or_else(|| format!("未知的星期: {}", day))?;
            args.push("/d".to_string());
            args.push(d.to_string());
        }
        "3" => {
            let dom = month_day(day).ok_or_else(|| format!("未知的日期: {}", day))?;
            args.push("/d".to_string());
            args.push(dom.to_string());
        }
        _ => {}
    }
    // 同名任务直接覆盖，保证「数据库一行 ↔ 系统一个任务」
    args.push("/f".to_string());

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = silent_command("schtasks")
        .args(&arg_refs)
        .output()
        .map_err(|e| format!("执行 schtasks 失败: {}", e))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "schtasks 创建失败: {}",
            decode_console_output(&out.stderr)
        ))
    }
}

/// 删除 Windows 计划任务。任务本就不存在时也算成功（目标状态已达成）。
fn delete_windows_task(task_name: &str) -> Result<(), String> {
    let out = silent_command("schtasks")
        .args(["/delete", "/tn", task_name, "/f"])
        .output()
        .map_err(|e| format!("执行 schtasks 失败: {}", e))?;

    if out.status.success() {
        return Ok(());
    }
    let err = decode_console_output(&out.stderr);
    // 找不到文件说明系统里本来就没有这个任务，与期望状态一致
    if err.contains("找不到") || err.to_lowercase().contains("not found") {
        return Ok(());
    }
    Err(format!("schtasks 删除失败: {}", err))
}

// ==================== 前端命令 ====================

/// 添加定时任务：注册计划任务 + 写入本地清单
#[tauri::command]
pub fn add_task(
    hour: i32,
    minute: i32,
    action: String,
    loop_type: String,
    day: String,
) -> Result<TaskOutcome, String> {
    if !(0..=23).contains(&hour) {
        return Err("小时必须在 0-23 之间".to_string());
    }
    if !(0..=59).contains(&minute) {
        return Err("分钟必须在 0-59 之间".to_string());
    }
    if action != "shutdown" && action != "reboot" {
        return Err(format!("未知动作: {}", action));
    }

    let mut warnings: Vec<String> = Vec::new();

    // 执行程序还没就位时任务照样登记：用户可能稍后才把程序放进来，
    // 但必须明确告知，否则到点不触发会很难排查。
    let program = action_program_path();
    if !program.exists() {
        warnings.push(format!("未找到执行程序：{}", program.display()));
    }

    let task_name = make_task_name(&action, hour, minute, &loop_type, &day);
    // 计划任务创建失败不中断流程（清单仍要可管理），但要让用户知道到点不会触发
    if let Err(e) = create_windows_task(&task_name, hour, minute, &loop_type, &day, &action) {
        warnings.push(e);
    }

    let conn = open()?;
    let mut stmt = conn
        .prepare("INSERT INTO tasks (action, hour, minute, loop_type, day) VALUES (?1, ?2, ?3, ?4, ?5)")
        .map_err(db_err)?;
    stmt.insert(rusqlite::params![action, hour, minute, loop_type, day])
        .map_err(db_err)?;

    Ok(TaskOutcome {
        affected: 1,
        warning: warnings.join("\n"),
    })
}

/// 删除单条任务：先摘掉计划任务，再清本地记录
#[tauri::command]
pub fn delete_task(task_id: i64) -> Result<TaskOutcome, String> {
    let conn = open()?;
    let task = task_by_id(&conn, task_id)
        .map_err(db_err)?
        .ok_or_else(|| "任务不存在".to_string())?;

    let task_name = make_task_name(&task.action, task.hour, task.minute, &task.loop_type, &task.day);
    let warning = match delete_windows_task(&task_name) {
        Ok(()) => String::new(),
        // 系统里的任务没摘掉就删本地记录，会留下无法在界面上取消的孤儿任务，必须提示
        Err(e) => format!("计划任务未能删除，它仍会按时触发：{}", e),
    };

    conn.execute("DELETE FROM tasks WHERE id = ?1", [task_id])
        .map_err(db_err)?;

    Ok(TaskOutcome {
        affected: 1,
        warning,
    })
}

/// 清空全部任务
#[tauri::command]
pub fn clear_all_tasks() -> Result<TaskOutcome, String> {
    let conn = open()?;
    let tasks = all_tasks(&conn).map_err(db_err)?;

    let mut failed: Vec<String> = Vec::new();
    for t in &tasks {
        let name = make_task_name(&t.action, t.hour, t.minute, &t.loop_type, &t.day);
        if let Err(e) = delete_windows_task(&name) {
            failed.push(format!("{}：{}", name, e));
        }
    }

    conn.execute("DELETE FROM tasks", []).map_err(db_err)?;

    let warning = if failed.is_empty() {
        String::new()
    } else {
        format!(
            "以下计划任务未能删除，它们仍会按时触发：\n{}",
            failed.join("\n")
        )
    };

    Ok(TaskOutcome {
        affected: tasks.len(),
        warning,
    })
}

/// 读取全部任务
#[tauri::command]
pub fn get_all_tasks() -> Result<Vec<TaskItem>, String> {
    let conn = open()?;
    all_tasks(&conn).map_err(db_err)
}

/// 判断相同规则的任务是否已存在，用于添加前去重
#[tauri::command]
pub fn exists_task(
    hour: i32,
    minute: i32,
    action: String,
    loop_type: String,
    day: String,
) -> Result<bool, String> {
    let conn = open()?;
    let mut stmt = conn
        .prepare(
            "SELECT COUNT(1) FROM tasks \
             WHERE action = ?1 AND hour = ?2 AND minute = ?3 AND loop_type = ?4 AND day = ?5",
        )
        .map_err(db_err)?;
    let count: i64 = stmt
        .query_row(
            rusqlite::params![action, hour, minute, loop_type, day],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    Ok(count > 0)
}

/// 取所有任务中最近的一个触发时间，供前端展示倒计时
#[tauri::command]
pub fn next_task() -> Result<Option<NextTask>, String> {
    let conn = open()?;
    let tasks = all_tasks(&conn).map_err(db_err)?;
    let now = now_epoch();

    Ok(tasks
        .iter()
        .filter_map(|t| {
            next_execute_epoch(&t.loop_type, &t.day, t.hour, t.minute)
                .filter(|epoch| *epoch > now)
                .map(|epoch| NextTask {
                    epoch,
                    action: t.action.clone(),
                })
        })
        .min_by_key(|n| n.epoch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_empty_and_ascii() {
        assert_eq!(decode_console_output(b""), "");
        assert_eq!(decode_console_output(b"OK 123"), "OK 123");
    }

    #[test]
    fn parses_month_day() {
        assert_eq!(month_day("12日"), Some(12));
        assert_eq!(month_day("12 日"), Some(12));
        assert_eq!(month_day("7"), Some(7));
        assert_eq!(month_day(""), None);
        assert_eq!(month_day("周一"), None);
    }

    #[test]
    fn parses_weekday() {
        assert_eq!(weekday_index("周一"), Some(1));
        assert_eq!(weekday_index("星期日"), Some(7));
        assert_eq!(weekday_index("星期天"), Some(7));
        assert_eq!(weekday_of("周三"), Some(Weekday::Wed));
        assert_eq!(schtasks_weekday("周六"), Some("SAT"));
        assert_eq!(weekday_index("12日"), None);
    }

    /// 不同循环规则必须落到不同的计划任务名，否则会互相覆盖
    #[test]
    fn task_name_distinguishes_rules() {
        assert_eq!(
            make_task_name("reboot", 3, 5, "1", ""),
            "WORKTOOL-reboot-0305-D0"
        );
        assert_eq!(
            make_task_name("reboot", 3, 5, "2", "周三"),
            "WORKTOOL-reboot-0305-W3"
        );
        assert_eq!(
            make_task_name("reboot", 3, 5, "3", "12日"),
            "WORKTOOL-reboot-0305-M12"
        );
        assert_eq!(
            make_task_name("shutdown", 3, 5, "1", ""),
            "WORKTOOL-shutdown-0305-D0"
        );
    }

    /// 每月任务在小月要钳制到月末，否则算不出触发时间
    #[test]
    fn days_in_month_handles_leap() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2023, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29);
        assert_eq!(days_in_month(1900, 2), 28);
        assert_eq!(days_in_month(2023, 4), 30);
    }

    /// 每天任务的下一次触发必须严格在未来
    #[test]
    fn daily_next_is_in_future() {
        let now = now_epoch();
        // 00:00 与 23:59 两端都测，覆盖「今天已过点」和「今天还没到点」两种分支
        for (h, m) in [(0, 0), (23, 59)] {
            let next = next_execute_epoch("1", "", h, m).expect("每天任务应能算出触发时间");
            assert!(next > now, "下一次触发时间必须晚于当前时间");
        }
    }

    /// 命令行格式是执行程序解析参数的契约：动作必须走 `--action` 具名开关，
    /// 且 exe 路径必须整体加引号（装在含空格目录时否则会被截断）。
    /// 路径取自运行时，故用 action_program_path() 构造期望值而非硬编码。
    #[test]
    fn action_command_line_uses_named_switch() {
        let quoted = format!("\"{}\"", action_program_path().display());

        for action in ["shutdown", "reboot"] {
            let cmd = action_command_line(action);
            assert_eq!(cmd, format!("{} --action {}", quoted, action));
            // 引号必须包住整个路径，不能只包住路径的一部分
            assert!(cmd.starts_with('"'), "路径缺少起始引号: {}", cmd);
            assert!(
                cmd.contains("\" --action "),
                "路径未以引号收尾或动作未走具名开关: {}",
                cmd
            );
        }
    }
}
