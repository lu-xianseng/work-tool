//! AI 对话模块
//!
//! 对话数据与 AI 模型配置均以本地 JSON 文件持久化（应用数据目录），
//! 所有文件读写都在 Rust 侧完成，前端仅通过 invoke 调用。
//!
//! 数据文件：
//! - chat_data.json    对话列表 + 每条对话的消息记录 + 当前激活对话
//! - ai_settings.json  模型列表（NEW-API / OpenAI 兼容服务），支持多模型
//!
//! 交互流程约定（与前端配合）：
//! 1. 前端先 add_message 保存用户消息；
//! 2. 再 stream_chat 以流式（SSE）方式调用 AI，增量文本通过 Channel 下发；
//! 3. 前端收到 Done 事件后 add_message 保存 assistant 消息；
//! 4. 首轮问答完成后前端调用 generate_conversation_title 自动生成对话标题。

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Manager, State};

/// 消息 id 序号：同毫秒内生成多条消息时自增，保证全局唯一
static MSG_SEQ: AtomicU64 = AtomicU64::new(0);

/// AI 请求超时时间（秒）。流式长回答与长思考场景给足余量。
const AI_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 自动生成标题时的长度约束（提示词侧约束）
const TITLE_MAX_CHARS: usize = 15;

// ==================== 数据模型 ====================

/// 一条对话消息。字段命名与前端 TS 接口一致（camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    /// "user" | "assistant"
    pub role: String,
    /// 纯文本；粘贴的图片以 markdown `![图片](data:image/...;base64,...)` 形式内嵌
    pub content: String,
    /// 毫秒时间戳
    pub created_at: u64,
}

/// 一条对话。数据模型与需求文档保持一致。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<ChatMessage>,
    /// 绑定的模型 id（模型列表中的一项）；旧数据缺失时为 None，发送时回退到第一个模型
    #[serde(default)]
    pub model_id: Option<String>,
}

/// 对话数据根结构（chat_data.json）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatData {
    conversations: Vec<Conversation>,
    active_conversation_id: String,
}

/// 一个 AI 模型配置（NEW-API / OpenAI 兼容服务）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModel {
    pub id: String,
    /// 展示名称，如「主力模型」「备用」
    pub name: String,
    /// 服务地址，如 https://your-new-api.example.com
    pub base_url: String,
    pub api_key: String,
    /// 模型名，如 gpt-4o-mini
    pub model: String,
}

/// ai_settings.json 的根结构（模型列表）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsFile {
    models: Vec<AiModel>,
}

/// 旧版单模型配置结构：{ baseUrl, apiKey, model }，仅用于迁移
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAiSettings {
    base_url: String,
    api_key: String,
    model: String,
}

/// 流式回复事件，通过 Tauri Channel 下发给前端。
///
/// `rename_all` 只作用于 variant 名（Delta → "delta"）；
/// 字段名必须用 `rename_all_fields` 才会统一转 camelCase
/// （否则 Done 会序列化成 full_text，前端读 fullText 得到 undefined）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatStreamEvent {
    /// 回复文本增量
    Delta { text: String },
    /// 流结束，携带完整回复文本（前端据此保存 assistant 消息）
    Done { full_text: String },
    /// 流中途错误（HTTP 已成功但读取/解析失败等）
    Error { message: String },
}

// ==================== 存储 ====================

/// 对话数据与 AI 设置的存储路径。由 setup 阶段解析一次后托管给 Tauri。
pub struct ChatStore {
    data_path: PathBuf,
    settings_path: PathBuf,
}

impl ChatStore {
    /// 数据统一存放在安装目录 data/ 下（安装目录 = 可执行文件所在目录，
    /// 开发模式为 target/debug 下的 data/）。
    pub fn new() -> Result<Self, String> {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|dir| dir.join("data")))
            .unwrap_or_else(|| PathBuf::from("data"));
        fs::create_dir_all(&dir)
            .map_err(|e| format!("无法创建数据目录 {}: {e}", dir.display()))?;
        Ok(ChatStore {
            data_path: dir.join("chat_data.json"),
            settings_path: dir.join("ai_settings.json"),
        })
    }

    fn load_chat_data(&self) -> Result<ChatData, String> {
        if !self.data_path.exists() {
            return Ok(ChatData {
                conversations: Vec::new(),
                active_conversation_id: String::new(),
            });
        }
        let content =
            fs::read_to_string(&self.data_path).map_err(|e| format!("读取对话数据失败: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("对话数据格式错误: {e}"))
    }

    /// 原子写入：先写临时文件再重命名，避免中途崩溃留下半个文件。
    fn save_chat_data(&self, data: &ChatData) -> Result<(), String> {
        let json = serde_json::to_string_pretty(data)
            .map_err(|e| format!("序列化对话数据失败: {e}"))?;
        let tmp = self.data_path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("写入对话数据失败: {e}"))?;
        fs::rename(&tmp, &self.data_path).map_err(|e| format!("保存对话数据失败: {e}"))?;
        Ok(())
    }

    /// 读取模型列表。兼容旧版单模型配置：发现旧结构时自动迁移为新结构并写回。
    fn load_settings(&self) -> Result<Vec<AiModel>, String> {
        if !self.settings_path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&self.settings_path)
            .map_err(|e| format!("读取 AI 设置失败: {e}"))?;

        // 新结构：{ "models": [...] }
        if let Ok(file) = serde_json::from_str::<AiSettingsFile>(&content) {
            return Ok(file.models);
        }
        // 旧结构：{ baseUrl, apiKey, model } → 迁移为单模型列表
        if let Ok(old) = serde_json::from_str::<LegacyAiSettings>(&content) {
            let models = vec![AiModel {
                id: format!("model_{}", now_millis()),
                name: "默认模型".to_string(),
                base_url: old.base_url,
                api_key: old.api_key,
                model: old.model,
            }];
            let _ = self.save_settings(&models);
            return Ok(models);
        }
        Err("AI 设置格式错误".to_string())
    }

    fn save_settings(&self, models: &[AiModel]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&AiSettingsFile {
            models: models.to_vec(),
        })
        .map_err(|e| format!("序列化 AI 设置失败: {e}"))?;
        fs::write(&self.settings_path, json).map_err(|e| format!("保存 AI 设置失败: {e}"))
    }
}

// ==================== 工具函数 ====================

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn conv_id() -> String {
    format!("conv_{}", now_millis())
}

fn msg_id() -> String {
    let seq = MSG_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("msg_{}_{}", now_millis(), seq)
}

/// 新建一条空对话（标题默认为「新对话」）。
fn new_conversation(now: u64) -> Conversation {
    Conversation {
        id: conv_id(),
        title: "新对话".to_string(),
        created_at: now,
        updated_at: now,
        messages: Vec::new(),
        model_id: None,
    }
}

/// 按最近更新排序，供列表展示与「删除后切到最近一条」使用。
fn sort_by_updated_desc(list: &mut Vec<Conversation>) {
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
}

/// 匹配消息正文中内嵌的图片 markdown：`![任意文字](data:image/...;base64,...)`
fn image_markdown_re() -> Result<Regex, String> {
    Regex::new(r"!\[[^\]]*\]\((data:image/[^)]+)\)")
        .map_err(|e| format!("图片解析规则初始化失败: {e}"))
}

/// 把一条用户消息拆成「纯文本 + 图片 data URL 列表」。
fn split_user_content(content: &str, re: &Regex) -> (String, Vec<String>) {
    let mut images = Vec::new();
    let mut text = String::new();
    let mut last = 0;
    for cap in re.captures_iter(content) {
        let m = cap.get(0).expect("匹配必有整体");
        text.push_str(&content[last..m.start()]);
        last = m.end();
        images.push(cap[1].to_string());
    }
    text.push_str(&content[last..]);
    (text.trim().to_string(), images)
}

/// 选定对话使用的模型：优先对话绑定的 modelId，缺失或失效时回退到列表第一个。
fn pick_model<'a>(models: &'a [AiModel], conversation: &Conversation) -> Result<&'a AiModel, String> {
    let mid = conversation.model_id.as_deref().unwrap_or("");
    let model = if mid.is_empty() {
        models.first()
    } else {
        models
            .iter()
            .find(|m| m.id == mid)
            .or_else(|| models.first())
    };
    model.ok_or_else(|| "请先在右上角配置 AI 模型（至少一个）".to_string())
}

/// 构造 OpenAI 兼容的 chat/completions 请求体。
///
/// 无图消息 content 为纯字符串；含图消息 content 为多段数组
/// （text + image_url，data URL 直接透传给服务端）。
fn build_payload(
    model: &AiModel,
    messages: &[ChatMessage],
    stream: bool,
) -> Result<serde_json::Value, String> {
    let re = image_markdown_re()?;
    let mut out = Vec::new();
    for m in messages {
        if m.role == "user" {
            let (text, images) = split_user_content(&m.content, &re);
            let content = if images.is_empty() {
                serde_json::Value::String(text)
            } else {
                let mut parts = Vec::new();
                if !text.is_empty() {
                    parts.push(serde_json::json!({"type": "text", "text": text}));
                }
                for url in images {
                    parts.push(serde_json::json!({
                        "type": "image_url",
                        "image_url": { "url": url }
                    }));
                }
                serde_json::Value::Array(parts)
            };
            out.push(serde_json::json!({"role": "user", "content": content}));
        } else {
            out.push(serde_json::json!({"role": m.role, "content": m.content}));
        }
    }
    Ok(serde_json::json!({
        "model": model.model,
        "messages": out,
        "stream": stream,
    }))
}

/// 非流式 completion 请求（用于生成标题等轻量调用），返回回复文本。
fn request_completion(model: &AiModel, payload: &serde_json::Value) -> Result<String, String> {
    let url = format!("{}/v1/chat/completions", model.base_url.trim_end_matches('/'));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(AI_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", model.api_key))
        .json(payload)
        .send()
        .map_err(|e| format!("请求 AI 服务失败（请检查网络与服务地址）: {e}"))?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().map_err(|e| format!("解析 AI 响应失败: {e}"))?;
    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("AI 服务返回错误（HTTP {status}）: {message}"));
    }

    let content = body
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if content.trim().is_empty() {
        return Err("AI 返回了空回复".to_string());
    }
    Ok(content)
}

// ==================== 命令：AI 模型配置 ====================

#[tauri::command]
pub fn get_ai_models(state: State<'_, ChatStore>) -> Result<Vec<AiModel>, String> {
    state.load_settings()
}

#[tauri::command]
pub fn save_ai_models(models: Vec<AiModel>, state: State<'_, ChatStore>) -> Result<(), String> {
    state.save_settings(&models)
}

// ==================== 命令：对话 CRUD ====================

#[tauri::command]
pub fn list_conversations(state: State<'_, ChatStore>) -> Result<Vec<Conversation>, String> {
    let mut data = state.load_chat_data()?;
    sort_by_updated_desc(&mut data.conversations);
    Ok(data.conversations)
}

#[tauri::command]
pub fn create_conversation(state: State<'_, ChatStore>) -> Result<Conversation, String> {
    let mut data = state.load_chat_data()?;
    let conv = new_conversation(now_millis());
    data.conversations.push(conv.clone());
    data.active_conversation_id = conv.id.clone();
    state.save_chat_data(&data)?;
    Ok(conv)
}

#[tauri::command]
pub fn get_active_conversation_id(state: State<'_, ChatStore>) -> Result<String, String> {
    Ok(state.load_chat_data()?.active_conversation_id)
}

#[tauri::command]
pub fn set_active_conversation(
    conversation_id: String,
    state: State<'_, ChatStore>,
) -> Result<(), String> {
    let mut data = state.load_chat_data()?;
    if !data.conversations.iter().any(|c| c.id == conversation_id) {
        return Err("对话不存在".to_string());
    }
    data.active_conversation_id = conversation_id;
    state.save_chat_data(&data)
}

/// 绑定对话使用的模型 id。
#[tauri::command]
pub fn set_conversation_model(
    conversation_id: String,
    model_id: String,
    state: State<'_, ChatStore>,
) -> Result<(), String> {
    let mut data = state.load_chat_data()?;
    let conv = data
        .conversations
        .iter_mut()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())?;
    conv.model_id = Some(model_id);
    state.save_chat_data(&data)
}

/// 重命名对话（标题为空时回退为「新对话」），返回最终标题。
#[tauri::command]
pub fn rename_conversation(
    conversation_id: String,
    title: String,
    state: State<'_, ChatStore>,
) -> Result<String, String> {
    let mut data = state.load_chat_data()?;
    let conv = data
        .conversations
        .iter_mut()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())?;
    let title = if title.trim().is_empty() {
        "新对话".to_string()
    } else {
        title.trim().to_string()
    };
    conv.title = title.clone();
    state.save_chat_data(&data)?;
    Ok(title)
}

/// 删除对话并返回新的列表。
///
/// 边界处理：
/// - 删除的是当前激活对话时，自动切换到最近更新的一条；
/// - 删除最后一个对话时，自动新建一个空对话。
#[tauri::command]
pub fn delete_conversation(
    conversation_id: String,
    state: State<'_, ChatStore>,
) -> Result<Vec<Conversation>, String> {
    let mut data = state.load_chat_data()?;
    data.conversations.retain(|c| c.id != conversation_id);

    if data.conversations.is_empty() {
        // 删除最后一个：自动新建空对话
        let conv = new_conversation(now_millis());
        data.conversations.push(conv.clone());
        data.active_conversation_id = conv.id.clone();
    } else if data.active_conversation_id == conversation_id {
        sort_by_updated_desc(&mut data.conversations);
        data.active_conversation_id = data.conversations[0].id.clone();
    } else {
        sort_by_updated_desc(&mut data.conversations);
    }

    state.save_chat_data(&data)?;
    Ok(data.conversations)
}

#[tauri::command]
pub fn get_conversation(
    conversation_id: String,
    state: State<'_, ChatStore>,
) -> Result<Conversation, String> {
    let data = state.load_chat_data()?;
    data.conversations
        .into_iter()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())
}

/// 向指定对话追加一条消息，并刷新该对话的更新时间。
#[tauri::command]
pub fn add_message(
    conversation_id: String,
    role: String,
    content: String,
    state: State<'_, ChatStore>,
) -> Result<ChatMessage, String> {
    let mut data = state.load_chat_data()?;
    let conv = data
        .conversations
        .iter_mut()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())?;

    let now = now_millis();
    let msg = ChatMessage {
        id: msg_id(),
        role,
        content,
        created_at: now,
    };
    conv.messages.push(msg.clone());
    conv.updated_at = now;
    state.save_chat_data(&data)?;
    Ok(msg)
}

// ==================== 命令：AI 流式对话 ====================

/// 读取指定对话的全部消息，以流式（SSE）方式调用 NEW-API（OpenAI 兼容
/// /v1/chat/completions），增量文本通过 Channel 下发。
///
/// 命令体为 async：真正的阻塞 IO（HTTP 流式读取）挪到 tokio 线程池执行。
/// 若直接写成同步命令，Tauri v2 会在主线程上跑完整段流式读取，
/// 期间窗口事件循环被锁死 → 点击无响应（但 WebView 渲染不受影响，
/// 表现就是「AI 还在输出、界面点不动」）。
#[tauri::command]
pub async fn stream_chat(
    conversation_id: String,
    channel: Channel<ChatStreamEvent>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ChatStore>();
        stream_chat_impl(conversation_id, channel, &state)
    })
    .await
    .map_err(|e| format!("流式任务执行失败: {e}"))?
}

/// stream_chat 的同步实现（由 async 命令在阻塞线程池中调用）。
fn stream_chat_impl(
    conversation_id: String,
    channel: Channel<ChatStreamEvent>,
    state: &ChatStore,
) -> Result<(), String> {
    let models = state.load_settings()?;
    let data = state.load_chat_data()?;
    let conv = data
        .conversations
        .iter()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())?;
    let model = pick_model(&models, conv)?;
    if conv.messages.is_empty() {
        return Err("当前对话还没有消息".to_string());
    }

    let payload = build_payload(model, &conv.messages, true)?;
    let url = format!("{}/v1/chat/completions", model.base_url.trim_end_matches('/'));

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(AI_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", model.api_key))
        .json(&payload)
        .send()
        .map_err(|e| format!("请求 AI 服务失败（请检查网络与服务地址）: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body: serde_json::Value = resp.json().unwrap_or(serde_json::Value::Null);
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("AI 服务返回错误（HTTP {status}）: {message}"));
    }

    // SSE 逐行解析：data: {...}，以 data: [DONE] 结束。
    let mut full_text = String::new();
    let mut reader = BufReader::new(resp);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("读取 AI 流失败: {e}"))?;
        if n == 0 {
            break;
        }

        let trimmed = line.trim();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let payload = data.trim();
        if payload == "[DONE]" {
            break;
        }

        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        if let Some(text) = v["choices"][0]["delta"]["content"].as_str() {
            if !text.is_empty() {
                full_text.push_str(text);
                channel
                    .send(ChatStreamEvent::Delta {
                        text: text.to_string(),
                    })
                    .map_err(|e| format!("发送流式数据失败: {e}"))?;
            }
        }
    }

    if full_text.trim().is_empty() {
        channel
            .send(ChatStreamEvent::Error {
                message: "AI 返回了空回复".to_string(),
            })
            .ok();
        return Ok(());
    }
    channel
        .send(ChatStreamEvent::Done {
            full_text: full_text.clone(),
        })
        .map_err(|e| format!("发送流结束事件失败: {e}"))?;
    Ok(())
}

// ==================== 命令：自动生成标题 ====================

/// 根据对话的首条用户消息，用 AI 生成简短标题并保存，返回新标题。
///
/// 生成失败（未配置模型 / AI 报错等）时返回 Err，前端可回退为本地截取。
#[tauri::command]
pub async fn generate_conversation_title(
    conversation_id: String,
    app: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ChatStore>();
        generate_conversation_title_impl(conversation_id, &state)
    })
    .await
    .map_err(|e| format!("标题生成任务执行失败: {e}"))?
}

/// generate_conversation_title 的同步实现（由 async 命令在阻塞线程池中调用）。
fn generate_conversation_title_impl(
    conversation_id: String,
    state: &ChatStore,
) -> Result<String, String> {
    let models = state.load_settings()?;
    let data = state.load_chat_data()?;
    let conv = data
        .conversations
        .iter()
        .find(|c| c.id == conversation_id)
        .ok_or_else(|| "对话不存在".to_string())?;
    let model = pick_model(&models, conv)?;

    let first_user = conv
        .messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .ok_or_else(|| "对话还没有用户消息".to_string())?;
    let (text, _images) = split_user_content(&first_user, &image_markdown_re()?);
    if text.trim().is_empty() {
        return Err("无法从消息中提取标题内容".to_string());
    }

    let system = format!(
        "你是对话标题生成器。根据用户的第一条消息，生成一个简短、贴合内容的对话标题，不超过 {} 个汉字。只返回标题本身，不要引号、句号或任何多余内容。",
        TITLE_MAX_CHARS
    );
    let payload = serde_json::json!({
        "model": model.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": format!("第一条消息内容：{}", text) }
        ],
        "stream": false,
    });

    let raw = request_completion(model, &payload)?;
    // 清洗：去掉可能出现的引号/空白，截断到上限
    let mut title = raw.trim().trim_matches('"').trim().to_string();
    let chars: Vec<char> = title.chars().collect();
    if chars.len() > TITLE_MAX_CHARS {
        title = chars[..TITLE_MAX_CHARS].iter().collect::<String>();
    }
    if title.is_empty() {
        title = "新对话".to_string();
    }

    // 写回对话标题
    let mut data = state.load_chat_data()?;
    if let Some(c) = data
        .conversations
        .iter_mut()
        .find(|c| c.id == conversation_id)
    {
        c.title = title.clone();
        state.save_chat_data(&data)?;
    }
    Ok(title)
}

// ==================== 单元测试 ====================

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 用临时目录构造一个不依赖 Tauri 的 ChatStore
    /// （目录名带进程 id + 自增序号，避免并行测试在同一毫秒内目录冲突）
    fn tmp_store() -> ChatStore {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "work_tool_chat_test_{}_{}",
            std::process::id(),
            seq
        ));
        fs::create_dir_all(&dir).unwrap();
        ChatStore {
            data_path: dir.join("chat_data.json"),
            settings_path: dir.join("ai_settings.json"),
        }
    }

    fn sample_model() -> AiModel {
        AiModel {
            id: "model_1".into(),
            name: "测试模型".into(),
            base_url: "https://example.com".into(),
            api_key: "sk-test".into(),
            model: "gpt-4o-mini".into(),
        }
    }

    #[test]
    fn split_user_content_extracts_images() {
        let re = image_markdown_re().unwrap();
        let (text, images) = split_user_content(
            "看图 ![图片](data:image/png;base64,AAA) 和 ![x](data:image/jpeg;base64,BBB) 结束",
            &re,
        );
        assert_eq!(text, "看图  和  结束");
        assert_eq!(images.len(), 2);
        assert_eq!(images[0], "data:image/png;base64,AAA");
        assert_eq!(images[1], "data:image/jpeg;base64,BBB");
    }

    #[test]
    fn split_user_content_plain_text() {
        let re = image_markdown_re().unwrap();
        let (text, images) = split_user_content("你好，没有图片", &re);
        assert_eq!(text, "你好，没有图片");
        assert!(images.is_empty());
    }

    #[test]
    fn legacy_settings_migrated_to_models() {
        let store = tmp_store();
        // 写入旧版单模型结构
        fs::write(
            &store.settings_path,
            r#"{"baseUrl":"https://old.example.com","apiKey":"sk-old","model":"deepseek-v3"}"#,
        )
        .unwrap();

        let models = store.load_settings().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].base_url, "https://old.example.com");
        assert_eq!(models[0].model, "deepseek-v3");

        // 迁移后应已写回新结构
        let content = fs::read_to_string(&store.settings_path).unwrap();
        assert!(content.contains("\"models\""));
    }

    #[test]
    fn create_add_and_persist() {
        let store = tmp_store();
        let conv = new_conversation(now_millis());
        let mut data = ChatData {
            conversations: vec![conv],
            active_conversation_id: "conv_x".into(),
        };
        data.conversations[0].id = "conv_x".into();
        store.save_chat_data(&data).unwrap();

        // 重新读取，验证持久化
        let mut loaded = store.load_chat_data().unwrap();
        assert_eq!(loaded.conversations.len(), 1);
        assert_eq!(loaded.active_conversation_id, "conv_x");

        // add_message 追加并更新 updated_at
        let msg = ChatMessage {
            id: "msg_1".into(),
            role: "user".into(),
            content: "你好".into(),
            created_at: now_millis(),
        };
        loaded.conversations[0].messages.push(msg);
        store.save_chat_data(&loaded).unwrap();
        let reloaded = store.load_chat_data().unwrap();
        assert_eq!(reloaded.conversations[0].messages.len(), 1);
    }

    #[test]
    fn delete_last_creates_new_conversation() {
        let store = tmp_store();
        let now = now_millis();
        let mut data = ChatData {
            conversations: vec![new_conversation(now)],
            active_conversation_id: String::new(),
        };
        data.conversations[0].id = "conv_only".into();
        data.active_conversation_id = "conv_only".into();
        store.save_chat_data(&data).unwrap();

        // 删除唯一对话：自动新建空对话并设为激活
        data.conversations.retain(|c| c.id != "conv_only");
        assert!(data.conversations.is_empty());
        let conv = new_conversation(now_millis());
        data.conversations.push(conv.clone());
        data.active_conversation_id = conv.id.clone();
        store.save_chat_data(&data).unwrap();

        let reloaded = store.load_chat_data().unwrap();
        assert_eq!(reloaded.conversations.len(), 1);
        assert_eq!(reloaded.conversations[0].messages.len(), 0);
        assert_eq!(reloaded.active_conversation_id, reloaded.conversations[0].id);
    }

    #[test]
    fn build_payload_with_images_and_stream_flag() {
        let model = sample_model();
        let messages = vec![
            ChatMessage {
                id: "m1".into(),
                role: "user".into(),
                content: "看这张图 ![图](data:image/png;base64,AAA)".into(),
                created_at: 0,
            },
            ChatMessage {
                id: "m2".into(),
                role: "assistant".into(),
                content: "看到了".into(),
                created_at: 0,
            },
        ];
        let payload = build_payload(&model, &messages, true).unwrap();
        assert_eq!(payload["model"], "gpt-4o-mini");
        assert_eq!(payload["stream"], true);
        assert!(payload.get("tools").is_none());
        let msgs = payload["messages"].as_array().unwrap();
        // 含图 user 消息：content 为数组
        let content = &msgs[0]["content"];
        assert!(content.is_array());
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAA");
        // assistant 消息：content 为纯字符串
        assert!(msgs[1]["content"].is_string());
    }

    #[test]
    fn pick_model_falls_back_to_first() {
        let models = vec![sample_model()];
        let mut conv = new_conversation(now_millis());
        conv.model_id = Some("model_missing".into());
        let picked = pick_model(&models, &conv).unwrap();
        assert_eq!(picked.id, "model_1");

        conv.model_id = None;
        let picked = pick_model(&models, &conv).unwrap();
        assert_eq!(picked.id, "model_1");
    }

    #[test]
    fn stream_events_serialize_camel_case_fields() {
        // Done 的 full_text 必须序列化为 fullText，前端才读得到
        let done = serde_json::to_value(ChatStreamEvent::Done {
            full_text: "你好".into(),
        })
        .unwrap();
        assert_eq!(done["type"], "done");
        assert_eq!(done["fullText"], "你好");
        assert!(done.get("full_text").is_none());

        let delta = serde_json::to_value(ChatStreamEvent::Delta {
            text: "你".into(),
        })
        .unwrap();
        assert_eq!(delta["type"], "delta");
        assert_eq!(delta["text"], "你");

        let err = serde_json::to_value(ChatStreamEvent::Error {
            message: "失败".into(),
        })
        .unwrap();
        assert_eq!(err["type"], "error");
        assert_eq!(err["message"], "失败");
    }
}
