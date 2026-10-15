
//! 进程管理模块
//!
//! 负责读取 apps.ini 配置、按进程树分组聚合 CPU/内存、结束进程分组、
//! 以及每 2 秒向前端推送一次快照。
//!
//! 从 main.rs 拆分而来，逻辑保持不变。

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sysinfo::{
    CpuRefreshKind, Pid, Process, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppItem {
    pub name: String,
    /// 分组内最早启动的进程（主进程）PID，0 表示未运行
    pub pid: u32,
    pub paths: Vec<String>,
    /// 整组 CPU 占用百分比，已除以逻辑核心数，归一化到 0~100，与任务管理器一致
    pub cpu: f64,
    /// 整组内存合计（字节），含所有子进程
    pub memory: u64,
    /// 分组内进程总数（含子进程），0 表示未运行
    pub process_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AppConfigItem {
    pub name: String,
    pub paths: Vec<String>,
}

/// 分组内单个进程的详细信息，用于前端悬停浮层展示。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProcessDetail {
    pub pid: u32,
    /// 进程树深度：0 为主进程，仅用于前端缩进体现层级，不作为展示字段
    pub depth: usize,
    pub name: String,
    /// 已除以逻辑核心数，归一化到 0~100，与任务管理器及主表格口径一致，
    /// 因此组内各进程之和等于主行显示的整组占用
    pub cpu: f64,
    /// 工作集（字节），含共享页
    pub memory: u64,
}

/// 常驻的 System 实例。
///
/// 必须跨刷新周期存活：sysinfo 的进程 CPU 占用率是靠「两次采样之间的时间差」算出来的，
/// 且要求两次间隔不小于 MINIMUM_CPU_UPDATE_INTERVAL（Windows 上为 200ms）。
/// 若每次调用都新建 System，进程对象永远是刚构造的状态
/// （last_update = now、cpu_usage = 0），采样差不足 200ms 会直接跳过计算，
/// 导致 CPU 读数恒为 0。
pub struct AppSystem {
    system: Mutex<System>,
}

impl AppSystem {
    /// 创建常驻实例。System::new_all() 会做一次全量采集，
    /// 之后由后台线程增量刷新，不再重复全量枚举。
    pub fn new() -> Arc<Self> {
        Arc::new(AppSystem {
            system: Mutex::new(System::new_all()),
        })
    }
}

/// 一个应用分组（主进程 + 其所有后代进程）的聚合结果。
struct ProcessGroup {
    /// 组内成员及其在进程树中的深度，按（深度升序，PID 升序）排列。
    /// 这样主进程及其近亲子进程排在前面，适合直接渲染成树形列表。
    members: Vec<(Pid, usize)>,
    /// 主进程 PID：组内 start_time 最小者，比 HashMap 遍历顺序稳定，避免界面上 PID 跳变。
    main_pid: Option<Pid>,
    /// 组内 CPU 占用之和（未除以核心数）
    cpu_sum: f64,
    /// 组内内存之和（字节）
    memory_sum: u64,
}

impl ProcessGroup {
    /// 结束进程时需叶子优先（深度降序）：父进程还活着时往往会重新拉起被杀掉的子进程。
    fn pids_leaf_first(&self) -> Vec<Pid> {
        self.members.iter().rev().map(|(pid, _)| *pid).collect()
    }
}

/// 配置文件随安装包分发到安装目录 config/ 下（安装目录 = exe 所在目录）
fn apps_ini_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|dir| dir.join("config").join("apps.ini")))
        .unwrap_or_else(|| PathBuf::from("apps.ini"))
}

fn parse_apps_ini() -> Vec<AppItem> {
    let content = match fs::read_to_string(apps_ini_path()) {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut order: Vec<String> = vec![];
    let mut paths_map: HashMap<String, Vec<String>> = HashMap::new();
    let mut current_section: Option<String> = None;

    for line in content.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }

        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let name = trimmed[1..trimmed.len() - 1].trim().to_string();
            current_section = Some(name.clone());

            if !paths_map.contains_key(&name) {
                order.push(name.clone());
                paths_map.insert(name, vec![]);
            }

            continue;
        }

        if let Some(section) = &current_section {
            if let Some(value) = trimmed.strip_prefix("clean_paths=") {
                let value = value.trim().to_string();
                if !value.is_empty() {
                    if let Some(list) = paths_map.get_mut(section) {
                        list.push(value);
                    }
                }
            }
        }
    }

    order
        .iter()
        .map(|name| AppItem {
            name: name.clone(),
            pid: 0,
            paths: paths_map.get(name).cloned().unwrap_or_default(),
            cpu: 0.0,
            memory: 0,
            process_count: 0,
        })
        .collect()
}

/// 去掉 .exe 后缀并转小写，用于不区分大小写地比较应用名与进程可执行文件名。
fn normalize_name(name: &str) -> String {
    let lower = name.trim().to_lowercase();
    lower
        .strip_suffix(".exe")
        .map(|s| s.to_string())
        .unwrap_or(lower)
}

/// 取进程可执行文件的去后缀小写文件名，例如
/// `C:\Program Files\Tencent\WeChat\WeChat.exe` -> `wechat`。
///
/// 用文件名而非完整路径做匹配，可避免路径中恰好含有应用名时的误命中
/// （旧实现用 exe 全路径做 contains 子串匹配）。
fn exe_stem(p: &Process) -> Option<String> {
    let file_name = p.exe()?.file_name()?.to_string_lossy().to_lowercase();
    Some(
        file_name
            .strip_suffix(".exe")
            .map(|s| s.to_string())
            .unwrap_or(file_name),
    )
}

/// 只刷新真正需要的字段，避免每 2 秒全量采集造成明显 CPU 开销。
///
/// - with_exe(OnlyIfNotSet)：exe 路径对已存在的进程不会变，只在首次发现时取一次；
///   分组匹配（exe_stem）依赖该字段，不能省
/// - without_tasks()：任务线程级信息在 Windows 上用不到，开销却不小
///
/// 注意：这里**故意**不包含任何按需的二次刷新入口，
/// 详见 get_app_process_details 的说明。
fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_cpu()
        .with_memory()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

/// 收集某个应用的完整进程分组：所有 exe 名匹配的进程作为根，
/// 再沿 parent/child 关系把它们的后代全部纳入。
///
/// 这样微信、Chrome、Electron 类应用的多进程会被合并统计，
/// 与任务管理器「进程」页的应用分组口径一致。
///
/// 注意：若用户同时开了多个彼此独立的同名实例，它们会被合并进同一组
/// （任务管理器则按实例分开显示）。对这个工具的用途而言，合并更符合预期。
fn collect_group(system: &System, target_stem: &str) -> Option<ProcessGroup> {
    let processes = system.processes();
    if processes.is_empty() {
        return None;
    }

    // 建立「父 PID -> 子 PID 列表」反向索引，用于向下遍历进程树
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, p) in processes {
        if let Some(ppid) = p.parent() {
            children.entry(ppid).or_default().push(*pid);
        }
    }

    let roots: Vec<Pid> = processes
        .iter()
        .filter(|(_, p)| exe_stem(p).as_deref() == Some(target_stem))
        .map(|(pid, _)| *pid)
        .collect();

    if roots.is_empty() {
        return None;
    }

    // BFS 收集整棵子树并记录深度。
    // seen 集合既做去重，也防止 PID 复用等异常父链造成死循环。
    let mut members: Vec<(Pid, usize)> = Vec::new();
    let mut seen: HashSet<Pid> = HashSet::new();
    let mut queue: VecDeque<(Pid, usize)> = roots.iter().map(|pid| (*pid, 0)).collect();

    while let Some((pid, depth)) = queue.pop_front() {
        if !seen.insert(pid) {
            continue;
        }
        members.push((pid, depth));
        if let Some(kids) = children.get(&pid) {
            for kid in kids {
                queue.push_back((*kid, depth + 1));
            }
        }
    }

    let mut cpu_sum = 0.0;
    let mut memory_sum = 0u64;
    let mut main_pid: Option<Pid> = None;
    let mut earliest_start = u64::MAX;

    for (pid, _) in &members {
        if let Some(p) = processes.get(pid) {
            cpu_sum += p.cpu_usage() as f64;
            memory_sum += p.memory();
            let start = p.start_time();
            if start < earliest_start {
                earliest_start = start;
                main_pid = Some(*pid);
            }
        }
    }

    // 深度升序 + PID 升序：主进程与近亲子进程排在前，适合直接渲染成树形列表
    members.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.as_u32().cmp(&b.0.as_u32())));

    Some(ProcessGroup {
        members,
        main_pid,
        cpu_sum,
        memory_sum,
    })
}

/// 读取当前快照并组装前端所需的列表。不触发刷新，刷新由后台线程统一负责。
fn build_app_list(app_system: &AppSystem) -> Vec<AppItem> {
    let mut apps = parse_apps_ini();
    if apps.is_empty() {
        return apps;
    }

    let guard = app_system.system.lock().unwrap_or_else(|e| e.into_inner());
    let system = &*guard;

    // cpu_usage() 返回的是「多核累加」语义，可超过 100（sysinfo 内部已乘过核心数）。
    // 任务管理器是归一化到 0~100% 的，所以这里除以逻辑核心数。
    let nb_cpus = system.cpus().len().max(1) as f64;

    for app in &mut apps {
        let stem = normalize_name(&app.name);
        if let Some(group) = collect_group(system, &stem) {
            app.pid = group.main_pid.map(|p| p.as_u32()).unwrap_or(0);
            app.cpu = group.cpu_sum / nb_cpus;
            app.memory = group.memory_sum;
            app.process_count = group.members.len();
        }
    }

    apps
}

/// 启动后台监控线程：预热 CPU 采样后，每 2 秒刷新一次并推送给前端。
///
/// 只在**主窗口模式**下调用。确认弹窗模式（由计划任务以 --action 拉起）
/// 只存活约 60 秒，跑这个线程纯属浪费 CPU。
pub fn spawn_monitor(handle: AppHandle, app_system: Arc<AppSystem>) {
    std::thread::spawn(move || {
        // ── 预热 ──
        // CPU 占用率基于两次采样的时间差，首次采样必然为 0。
        // 这里先取一次基线，等待 MINIMUM_CPU_UPDATE_INTERVAL(200ms) 后再采一次，
        // 让应用启动后第一轮推送就有有效数值，而不是一片 0.0%。
        {
            let mut sys = app_system.system.lock().unwrap_or_else(|e| e.into_inner());
            // 必须先刷新 CPU 列表，否则 cpus() 为空、拿不到逻辑核心数，
            // 而 CPU 归一化依赖核心数。
            sys.refresh_cpu_list(CpuRefreshKind::nothing());
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
        }
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);

        loop {
            {
                let mut sys = app_system.system.lock().unwrap_or_else(|e| e.into_inner());
                // remove_dead_processes = true：自动清理已退出进程，
                // 避免长运行后残留陈旧条目。
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
            }

            let list = build_app_list(&app_system);
            let _ = handle.emit("app-updated", list);

            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

#[tauri::command]
pub fn get_app_list(state: State<'_, Arc<AppSystem>>) -> Vec<AppItem> {
    build_app_list(&state)
}

/// 结束一个应用的**整个进程分组**（主进程及其所有后代）。
///
/// 不能只杀主进程：sysinfo 在 Windows 上的 kill 调用的是 `taskkill /PID /F`，
/// 不带 `/T`，只结束单个进程。子进程会变成孤儿继续占用内存，
/// 而且下一次刷新时分组会重新落到残留的子进程上，界面上的 PID 随之跳变。
#[tauri::command]
pub fn kill_app(name: String, state: State<'_, Arc<AppSystem>>) -> Result<String, String> {
    let stem = normalize_name(&name);

    let guard = state.system.lock().unwrap_or_else(|e| e.into_inner());
    let system = &*guard;

    let group =
        collect_group(system, &stem).ok_or_else(|| format!("未找到正在运行的进程: {}", name))?;

    // 叶子优先：父进程还活着时通常会重新拉起被杀掉的子进程，所以从最深层开始结束
    let pids = group.pids_leaf_first();
    let total = pids.len();
    let mut killed = 0usize;
    let mut failures: Vec<u32> = Vec::new();

    for pid in &pids {
        match system.process(*pid) {
            Some(p) => {
                if p.kill() {
                    killed += 1;
                } else {
                    failures.push(pid.as_u32());
                }
            }
            None => failures.push(pid.as_u32()),
        }
    }

    drop(guard);

    if killed == 0 {
        return Err(format!("无法结束进程 {}（共 {} 个）", name, total));
    }

    if failures.is_empty() {
        Ok(format!("已结束 {}（{} 个进程）", name, killed))
    } else {
        Ok(format!(
            "已结束 {} 的 {} 个进程，{} 个未能结束（可能需要管理员权限）",
            name,
            killed,
            failures.len()
        ))
    }
}

/// 返回某个应用分组内**全部**进程的详细信息（主进程 + 所有后代），按进程树顺序排列。
///
/// ⚠️ 本命令是**只读快照**，刻意不调用任何 refresh。原因：
/// sysinfo 的 compute_cpu_usage 会无条件把 last_update 置为 Instant::now()。
/// 若在这里对 Some(pids) 做一次带 with_cpu() 的局部刷新，就会重置这些进程的
/// 差分基线，把后台线程每 2 秒的 CPU 计算打断，造成读数尖刺甚至归零。
/// 悬停查询频率远高于后台刷新，所以必须只读，由后台线程独占采样权。
#[tauri::command]
pub fn get_app_process_details(
    name: String,
    state: State<'_, Arc<AppSystem>>,
) -> Result<Vec<ProcessDetail>, String> {
    let stem = normalize_name(&name);

    let guard = state.system.lock().unwrap_or_else(|e| e.into_inner());
    let system = &*guard;

    let group =
        collect_group(system, &stem).ok_or_else(|| format!("未找到正在运行的进程: {}", name))?;

    // 与 build_app_list 保持同一口径，否则详情里各子进程之和会对不上主行数值
    let nb_cpus = system.cpus().len().max(1) as f64;

    let details: Vec<ProcessDetail> = group
        .members
        .iter()
        .filter_map(|(pid, depth)| {
            let p = system.process(*pid)?;
            Some(ProcessDetail {
                pid: pid.as_u32(),
                depth: *depth,
                name: p.name().to_string_lossy().to_string(),
                cpu: p.cpu_usage() as f64 / nb_cpus,
                memory: p.memory(),
            })
        })
        .collect();

    if details.is_empty() {
        return Err(format!("{} 的进程信息不可读", name));
    }

    Ok(details)
}

#[tauri::command]
pub fn initialize_app(name: String) -> Result<String, String> {
    let apps = parse_apps_ini();

    let target = apps
        .into_iter()
        .find(|a| a.name == name)
        .ok_or_else(|| format!("未找到应用: {}", name))?;

    if target.paths.is_empty() {
        return Ok(format!("{} 没有配置清理路径", name));
    }

    for raw in &target.paths {
        let path = PathBuf::from(raw);

        if !path.exists() {
            continue;
        }

        if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| format!("删除目录失败: {}\n路径: {}", e, path.display()))?;
        } else {
            fs::remove_file(&path)
                .map_err(|e| format!("删除文件失败: {}\n路径: {}", e, path.display()))?;
        }
    }

    Ok(format!("{} 初始化完成", name))
}

#[tauri::command]
pub fn get_app_config() -> Result<Vec<AppConfigItem>, String> {
    let apps = parse_apps_ini();
    Ok(apps
        .into_iter()
        .map(|a| AppConfigItem {
            name: a.name,
            paths: a.paths,
        })
        .collect())
}

/// 读取 apps.ini 中第一个配置段之前的注释/空行，作为文件头部说明原样保留。
///
/// 背景：parse_apps_ini 会跳过所有注释行，而 save_app_config 是全量重写，
/// 因此任何一次保存都会抹掉文件顶部的用法说明。
/// 改为「返回即保存」后，保存成为进出设置页的必经路径 ——
/// 用户哪怕什么都没改，注释也会被静默清掉，所以必须显式保留。
///
/// 只保留第一个段之前的头部（而非散落各处的行间注释）：
/// 头部说明是稳定的使用指引，而段内注释与具体条目绑定，
/// 条目被增删后其归属已无意义，强行保留反而会产生错位的注释。
fn read_header_comments() -> String {
    let content = match fs::read_to_string(apps_ini_path()) {
        Ok(c) => c,
        // 文件不存在或不可读（如首次运行）：没有头部需要保留
        Err(_) => return String::new(),
    };

    let mut header = String::new();
    for line in content.lines() {
        let trimmed = line.trim();
        // 遇到第一个配置段就停止，其后的内容一律由本次保存重建
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            break;
        }
        header.push_str(line);
        header.push('\n');
    }

    // 头部与第一个段之间留一个空行；头部为空时不加，避免文件开头多出空行
    if header.trim().is_empty() {
        String::new()
    } else {
        header + "\n"
    }
}

#[tauri::command]
pub fn save_app_config(apps: Vec<AppConfigItem>) -> Result<(), String> {
    let mut content = read_header_comments();

    for app in &apps {
        content.push_str(&format!("[{}]\n", app.name));
        for path in &app.paths {
            content.push_str(&format!("clean_paths={}\n", path));
        }
        content.push('\n');
    }

    fs::write(apps_ini_path(), content).map_err(|e| e.to_string())
}