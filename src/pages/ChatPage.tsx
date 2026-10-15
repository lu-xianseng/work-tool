import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Channel } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  chatApi,
  makeLocalTitle,
  type AiModel,
  type ChatMessage,
  type ChatStreamEvent,
  type Conversation,
} from "../chat";

interface ChatPageProps {
  onToast: (message: string) => void;
  /** 需要用户明确知晓的问题，走弹窗而非一闪而过的 toast */
  onError: (title: string, message: string) => void;
  /** 二次确认弹窗（删除对话等破坏性操作） */
  onConfirm: (title: string, message: string, onOk: () => void) => void;
}

/** 粘贴图片的大小上限（原始文件字节）：防止 JSON 文件与 AI 请求体过度膨胀 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** 文本类附件的大小上限：文本内容会整体嵌入消息，过大拖慢请求 */
const MAX_TEXT_FILE_BYTES = 1024 * 1024;

/** 图片扩展名：data URL 内嵌（后端转 OpenAI image_url） */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** 文本类扩展名：读取内容后以「附件」形式嵌入消息正文
 *  （含 EDA 文本格式：KiCad S-表达式、Eagle XML、网表、Gerber） */
const TEXT_EXT_RE =
  /\.(txt|md|markdown|json|js|jsx|ts|tsx|py|java|c|cpp|h|hpp|css|html|htm|xml|yaml|yml|toml|ini|cfg|conf|log|csv|sh|bat|ps1|rs|go|sql|svg|env|gitignore|dockerfile|sch|pcb|brd|net|gbr|kicad_sch|kicad_pcb|kicad_mod|kicad_sym|kicad_pro|kicad_prl)$/i;

/** 附件分类：image → data URL；text → 读取文本；其他类型暂不支持 */
type AttachmentKind = "image" | "text" | "unsupported";

function classifyFile(name: string): AttachmentKind {
  if (IMAGE_EXT_RE.test(name)) return "image";
  if (TEXT_EXT_RE.test(name)) return "text";
  return "unsupported";
}

/**
 * 二进制文件被强制按 UTF-8 读取时的特征检测：
 * 含 null 字节，或出现大量替换符（U+FFFD）。
 * 用于识别 Altium 等二进制格式的 PCB/SCH，避免把乱码发给 AI。
 */
function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  let replacement = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0xfffd) replacement++;
  }
  return replacement > Math.max(10, text.length * 0.02);
}

/** 从文件名提取语言标注（供代码块头部显示） */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return "";
  const ext = name.slice(i + 1).toLowerCase();
  return /^[\w+-]{1,10}$/.test(ext) ? ext : "";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ==================== 代码块（一键复制） ====================

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("复制代码失败:", e);
    }
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-lang">{lang || "code"}</span>
        <button className="code-copy-btn" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ==================== 消息正文渲染（轻量 markdown） ====================

/** 内嵌图片 markdown：data URL 或 http(s) 链接 */
const INLINE_IMAGE_RE = /!\[[^\]]*\]\((data:image\/[^)\s]+|https?:\/\/[^)\s]+)\)/g;

/** 渲染除代码块之外的文本段：图片 markdown → <img>，其余按 pre-wrap 保留换行 */
function renderInlineText(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = INLINE_IMAGE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push(<img key={`img${key++}`} className="chat-msg-img" src={m[1]} alt="图片" />);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return (
    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {nodes}
    </span>
  );
}

/** 把消息正文渲染为节点：``` 代码块特殊处理，其余文本走 renderInlineText */
function renderContent(content: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const blockRe = /```([\w+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = blockRe.exec(content)) !== null) {
    if (m.index > last) {
      nodes.push(<span key={`t${key++}`}>{renderInlineText(content.slice(last, m.index))}</span>);
    }
    nodes.push(
      <CodeBlock
        key={`c${key++}`}
        lang={m[1].trim()}
        code={m[2].replace(/\n$/, "")}
      />
    );
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    nodes.push(<span key={`t${key++}`}>{renderInlineText(content.slice(last))}</span>);
  }
  if (nodes.length === 0) return [<span key="empty">{renderInlineText(content)}</span>];
  return nodes;
}

// ==================== 设置子页（多模型配置） ====================

interface ChatSettingsPageProps {
  onToast: (message: string) => void;
  onError: (title: string, message: string) => void;
  onBack: () => void;
}

interface ModelEditorProps {
  /** null = 添加新模型；非 null = 编辑该模型 */
  initial: AiModel | null;
  onCancel: () => void;
  onSave: (m: AiModel) => void;
}

/** 模型编辑弹框：添加 / 修改统一入口，避免表单撑高页面 */
function ModelEditor({ initial, onCancel, onSave }: ModelEditorProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [model, setModel] = useState(initial?.model ?? "");

  const submit = () => {
    onSave({
      id: initial?.id ?? `model_${Date.now()}`,
      name: name.trim() || "未命名模型",
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
    });
  };

  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal-box chat-model-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{initial ? "编辑模型" : "添加模型"}</div>
        <div className="timer-form">
          <div className="timer-form-row">
            <label className="timer-form-label">名称</label>
            <input
              className="config-input timer-form-control"
              placeholder="主力模型"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="timer-form-row">
            <label className="timer-form-label">服务地址</label>
            <input
              className="config-input timer-form-control"
              placeholder="https://your-new-api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="timer-form-row">
            <label className="timer-form-label">API Key</label>
            <input
              type="password"
              className="config-input timer-form-control"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="timer-form-row">
            <label className="timer-form-label">模型名</label>
            <input
              className="config-input timer-form-control"
              placeholder="gpt-4o-mini"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button className="modal-btn modal-btn-confirm" onClick={submit}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** AI 配置子页：模型列表增删改，添加 / 修改走弹框。返回时自动保存。 */
function ChatSettingsPage({ onToast, onError, onBack }: ChatSettingsPageProps) {
  const [models, setModels] = useState<AiModel[]>([]);
  /** 弹框开关；editingIndex = null 表示添加，否则编辑对应下标 */
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);

  useEffect(() => {
    chatApi
      .getAiModels()
      .then((list) => setModels(list))
      .catch((e) => onError("出错了", `读取 AI 配置失败: ${e}`));
  }, [onError]);

  const removeModel = (idx: number) =>
    setModels((prev) => prev.filter((_, i) => i !== idx));

  const handleEditorSave = (m: AiModel) => {
    setModels((prev) =>
      editingIndex === null
        ? [...prev, m]
        : prev.map((x, i) => (i === editingIndex ? m : x))
    );
    setEditorOpen(false);
    setEditingIndex(null);
  };

  /** 返回即保存：把当前列表整体落盘，保存失败则留在页面提示 */
  const persistAndBack = async () => {
    const cleaned = models.map((m) => ({
      ...m,
      name: m.name.trim() || "未命名模型",
      baseUrl: m.baseUrl.trim(),
      apiKey: m.apiKey.trim(),
      model: m.model.trim(),
    }));
    try {
      await chatApi.saveAiModels(cleaned);
      onToast("AI 配置已保存");
      onBack();
    } catch (e) {
      onError("出错了", `保存 AI 配置失败: ${e}`);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="back-btn" onClick={() => void persistAndBack()} title="返回并保存">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span style={{ marginLeft: 4, fontSize: 14 }}>返回</span>
        </button>
        <span className="settings-hint">模型配置</span>
      </div>

      <div className="card">
        <div className="config-add-section">
          <h4>模型列表（对话时可选）</h4>
          <p className="chat-settings-tip">
            支持配置多个模型；对话界面可下拉切换，每个对话记忆自己使用的模型。
            点击列表项可修改模型信息。
          </p>

          {models.length === 0 && (
            <p className="chat-settings-tip">还没有模型，点击「添加模型」开始配置。</p>
          )}
          {models.map((m, idx) => (
            <div
              key={m.id}
              className="chat-model-row"
              title={`${m.baseUrl || "未填服务地址"} · ${m.model || "未填模型名"}`}
              onClick={() => {
                setEditingIndex(idx);
                setEditorOpen(true);
              }}
            >
              <span className="chat-model-row-name">{m.name || "未命名模型"}</span>
              <button
                className="chat-model-del-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  removeModel(idx);
                }}
              >
                删除
              </button>
            </div>
          ))}

          <div className="timer-form-actions">
            <button
              className="config-add-path-btn"
              onClick={() => {
                setEditingIndex(null);
                setEditorOpen(true);
              }}
            >
              ＋ 添加模型
            </button>
          </div>
        </div>
      </div>

      {editorOpen && (
        <ModelEditor
          initial={editingIndex === null ? null : (models[editingIndex] ?? null)}
          onCancel={() => {
            setEditorOpen(false);
            setEditingIndex(null);
          }}
          onSave={handleEditorSave}
        />
      )}
    </div>
  );
}

// ==================== 主页面 ====================

interface PendingAttachment {
  id: number;
  kind: "image" | "text";
  name: string;
  size: number;
  /** 图片：data URL */
  dataUrl?: string;
  /** 文本：文件内容 */
  text?: string;
}

/**
 * AI 对话页：左侧对话列表（新建 / 切换 / 删除），右侧消息区 + 模型选择 + 输入框。
 * 交互约定：
 * - 没有对话时自动新建「新对话」；新建后绑定当前选中的模型；
 * - 发送消息 = add_message(user) → stream_chat（流式渲染）→ add_message(assistant)；
 * - 首轮问答完成后用 AI 自动生成对话标题（失败则本地截取回退）；
 * - 删除当前激活对话后自动切换到最近一条；删除最后一个自动新建。
 */
export function ChatPage({ onToast, onError, onConfirm }: ChatPageProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  /** 流式回复文本：null = 未在流式；空串 = 已开始、尚未收到增量 */
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const messagesRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 流式文本累积缓冲 + rAF 节流：合并高频 delta，避免每个 IPC 都触发全量渲染（长回复时拖垮主线程） */
  const streamBufRef = useRef("");
  const rafRef = useRef<number | null>(null);

  // 组件卸载时取消未完成的 rAF 调度
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const activeConv = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId]
  );

  /** 当前对话使用的模型 id：优先对话绑定，未绑定/失效时回退到列表第一个 */
  const currentModelId =
    activeConv?.modelId && models.some((m) => m.id === activeConv.modelId)
      ? activeConv.modelId
      : (models[0]?.id ?? "");

  /** 重新拉取模型列表（从设置页返回后刷新，保证新增/删除立即生效） */
  const loadModels = useCallback(async () => {
    try {
      setModels(await chatApi.getAiModels());
    } catch {
      // 模型加载失败不阻塞对话页
    }
  }, []);

  // 首屏加载：读取对话列表与模型列表；无对话时自动新建；按后端持久化的激活对话恢复
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, modelList] = await Promise.all([
          chatApi.listConversations(),
          chatApi.getAiModels(),
        ]);
        if (cancelled) return;
        setModels(modelList);
        if (list.length === 0) {
          const conv = await chatApi.createConversation();
          if (cancelled) return;
          const mid = modelList[0]?.id;
          if (mid) {
            try {
              await chatApi.setConversationModel(conv.id, mid);
              conv.modelId = mid;
            } catch {
              // 绑定失败不阻塞进入对话
            }
          }
          setConversations([conv]);
          setActiveId(conv.id);
          return;
        }
        setConversations(list);
        const active = await chatApi.getActiveConversationId();
        if (cancelled) return;
        setActiveId(list.some((c) => c.id === active) ? active : list[0].id);
      } catch (e) {
        onError("出错了", `加载对话失败: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  // 新消息 / 切换对话 / 流式增量 / 发送状态变化后滚动到底部
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, activeConv?.messages.length, sending, streamingText]);

  /** 追加一条消息到指定对话，并把该对话移到列表最前（最近更新优先） */
  const appendMessage = (convId: string, msg: ChatMessage) => {
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.id === convId
          ? { ...c, updatedAt: msg.createdAt, messages: [...c.messages, msg] }
          : c
      );
      const idx = next.findIndex((c) => c.id === convId);
      if (idx > 0) {
        const [conv] = next.splice(idx, 1);
        next.unshift(conv);
      }
      return next;
    });
  };

  /** 更新某对话标题（AI 生成或本地回退后写回列表） */
  const updateTitle = (convId: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, title } : c)));
  };

  const handleNew = async () => {
    try {
      const conv = await chatApi.createConversation();
      // 新建对话绑定当前选中的模型
      const mid = activeConv?.modelId && models.some((m) => m.id === activeConv.modelId)
        ? activeConv.modelId
        : (models[0]?.id ?? "");
      if (mid) {
        try {
          await chatApi.setConversationModel(conv.id, mid);
          conv.modelId = mid;
        } catch {
          // 绑定失败不阻塞
        }
      }
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
    } catch (e) {
      onError("出错了", `新建对话失败: ${e}`);
    }
  };

  const handleSwitch = async (id: string) => {
    if (id === activeId) return;
    setActiveId(id);
    try {
      await chatApi.setActiveConversation(id);
    } catch {
      // 持久化激活状态失败不阻塞切换，仅静默忽略
    }
  };

  /** 切换当前对话使用的模型：本地立即生效，后端持久化 */
  const handleModelChange = async (modelId: string) => {
    if (!activeId || !modelId) return;
    const convId = activeId;
    setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, modelId } : c)));
    try {
      await chatApi.setConversationModel(convId, modelId);
    } catch {
      onToast("模型切换保存失败，重启后可能丢失");
    }
  };

  const handleDelete = (id: string) => {
    onConfirm(
      "删除对话",
      "确定要删除这条对话吗？删除后其中的消息记录不可恢复。",
      async () => {
        try {
          const list = await chatApi.deleteConversation(id);
          setConversations(list);
          // 后端保证列表非空；删除的是当前激活对话时切到最近一条
          if (id === activeId) setActiveId(list[0].id);
        } catch (e) {
          onError("出错了", `删除对话失败: ${e}`);
        }
      }
    );
  };

  /** 首轮问答完成后生成标题：AI 生成，失败回退本地截取首条消息 */
  const generateTitleFor = async (convId: string, userContent: string) => {
    try {
      const title = await chatApi.generateConversationTitle(convId);
      updateTitle(convId, title);
    } catch {
      const t = makeLocalTitle(userContent);
      if (t !== "新对话") {
        try {
          const renamed = await chatApi.renameConversation(convId, t);
          updateTitle(convId, renamed);
        } catch {
          // 回退失败则保持「新对话」，不阻塞
        }
      }
    }
  };

  /** 把一个文件加入待发送附件列表（图片 → data URL，文本 → 读取内容） */
  const addAttachment = (f: File) => {
    const kind = classifyFile(f.name);
    const id = Date.now() + Math.random();

    if (kind === "image") {
      if (f.size > MAX_IMAGE_BYTES) {
        onToast(`图片「${f.name}」超过 4MB，已跳过`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setPendingAttachments((prev) => [
          ...prev,
          {
            id,
            kind: "image",
            name: f.name,
            size: f.size,
            dataUrl: String(reader.result),
          },
        ]);
      };
      reader.readAsDataURL(f);
    } else if (kind === "text") {
      if (f.size > MAX_TEXT_FILE_BYTES) {
        onToast(`附件「${f.name}」超过 1MB，已跳过`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result);
        // 二进制格式（如 Altium 的 PcbDoc/SchDoc）强读为文本会乱码，直接拒收并说明
        if (looksBinary(text)) {
          onToast(
            `「${f.name}」是二进制格式，无法直接解读；请先在 EDA 工具中导出为网表或 KiCad/文本格式再上传`
          );
          return;
        }
        setPendingAttachments((prev) => [
          ...prev,
          {
            id,
            kind: "text",
            name: f.name,
            size: f.size,
            text,
          },
        ]);
      };
      reader.readAsText(f, "utf-8");
    } else {
      onToast(`暂不支持「${f.name}」这类文件，仅支持图片与文本类附件（含 EDA 文本格式）`);
    }
  };

  /** 附件按钮：打开文件选择器（可多选） */
  const handlePickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许重复选择同一文件
    for (const f of files) addAttachment(f);
  };

  /** 粘贴：读取剪贴板中的图片文件转 data URL 加入待发送列表 */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault(); // 阻止图片被当作文本粘进输入框

    for (const f of files) addAttachment(f);
  };

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && pendingAttachments.length === 0) || !activeId || sending) return;
    if (models.length === 0) {
      onToast("请先在右上角配置 AI 模型");
      return;
    }

    // 图片以 markdown 内嵌（后端解析转 image_url）；文本附件以「附件 + 代码块」嵌入正文
    const content = [
      text,
      ...pendingAttachments.map((a) => {
        if (a.kind === "image") return `![图片](${a.dataUrl})`;
        const lang = extOf(a.name);
        return `【附件：${a.name}】\n\`\`\`${lang}\n${a.text ?? ""}\n\`\`\``;
      }),
    ]
      .filter(Boolean)
      .join("\n");

    const convId = activeId;
    // 首轮判定：发送前对话为空，且标题还是默认的「新对话」
    const isFirstRound =
      activeConv !== null &&
      activeConv.messages.length === 0 &&
      (!activeConv.title || activeConv.title === "新对话");

    setInput("");
    setPendingAttachments([]);
    setStreamingText("");
    setStreamError(null);
    setSending(true);
    streamBufRef.current = "";

    try {
      // 1. 保存用户消息
      const userMsg = await chatApi.addMessage(convId, "user", content);
      appendMessage(convId, userMsg);

      // 2. 流式调用 AI：增量经 rAF 节流后实时渲染，Done 后保存 assistant 消息
      const channel = new Channel<ChatStreamEvent>();
      channel.onmessage = (evt) => {
        if (evt.type === "delta") {
          streamBufRef.current += evt.text;
          if (rafRef.current == null) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;
              setStreamingText(streamBufRef.current);
            });
          }
        } else if (evt.type === "error") {
          if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          setStreamingText(null);
          setStreamError(evt.message);
        } else if (evt.type === "done") {
          if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          setStreamingText(null);
          const full = evt.fullText ?? "";
          void (async () => {
            try {
              // 3. 保存 assistant 消息
              const aiMsg = await chatApi.addMessage(convId, "assistant", full);
              appendMessage(convId, aiMsg);
              // 4. 首轮问答完成后自动生成标题
              if (isFirstRound) void generateTitleFor(convId, content);
            } catch (e) {
              onError("出错了", `保存 AI 回复失败: ${e}`);
            }
          })();
        }
      };

      await chatApi.streamChat(convId, channel);
    } catch (e) {
      setStreamingText(null);
      onError("出错了", String(e));
    } finally {
      setSending(false);
    }
  };

  if (showSettings) {
    return (
      <ChatSettingsPage
        onToast={onToast}
        onError={onError}
        onBack={() => {
          setShowSettings(false);
          // 设置页可能增删了模型，返回后刷新列表
          void loadModels();
        }}
      />
    );
  }

  return (
    <>
      <div className="settings-header">
        <h2>AI 对话</h2>
        <button
          className="settings-btn"
          onClick={() => setShowSettings(true)}
          title="AI 配置"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06-.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="chat-layout">
        {/* 左侧：对话列表 */}
        <div className="chat-sidebar">
          <button className="chat-new-btn" onClick={() => void handleNew()}>
            ＋ 新建对话
          </button>
          <div className="chat-list">
            {conversations.map((c) => (
              <div
                key={c.id}
                className={c.id === activeId ? "chat-item chat-item-active" : "chat-item"}
                onClick={() => void handleSwitch(c.id)}
                title={c.title || "新对话"}
              >
                <div className="chat-item-title">{c.title || "新对话"}</div>
                <div className="chat-item-meta">{formatTime(c.updatedAt)}</div>
                <button
                  className="chat-item-del"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(c.id);
                  }}
                  title="删除对话"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧：消息区 + 输入框 */}
        <div className="chat-main">
          <div className="chat-messages" ref={messagesRef}>
            {activeConv === null ? (
              <div className="chat-welcome">
                <h3>AI 对话</h3>
                <p>选择一个对话，或新建一个开始聊天。</p>
              </div>
            ) : (
              <>
                {activeConv.messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={
                      msg.role === "user" ? "chat-msg chat-msg-user" : "chat-msg chat-msg-assistant"
                    }
                  >
                    <div className="chat-msg-role">
                      {msg.role === "user" ? "我" : "AI"}
                    </div>
                    <div className="chat-msg-body">{renderContent(msg.content)}</div>
                  </div>
                ))}
                {/* 流式输出中的 AI 消息：轻量纯文本渲染（不做代码块/图片正则解析），
                    done 后由正式消息走完整 renderContent，避免每帧全量解析拖慢主线程 */}
                {streamingText !== null && (
                  <div className="chat-msg chat-msg-assistant">
                    <div className="chat-msg-role">AI</div>
                    <div className="chat-msg-body">
                      {streamingText ? (
                        <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {streamingText}
                        </span>
                      ) : (
                        <span className="chat-thinking">正在思考…</span>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
            {streamError && (
              <div className="chat-stream-error">
                AI 回复出错了：{streamError}
              </div>
            )}
          </div>

          <div className="chat-input-area">
            {pendingAttachments.length > 0 && (
              <div className="chat-preview-row">
                {pendingAttachments.map((a) =>
                  a.kind === "image" ? (
                    <div key={a.id} className="chat-preview-item">
                      <img src={a.dataUrl} alt={a.name} />
                      <button
                        className="chat-preview-remove"
                        onClick={() =>
                          setPendingAttachments((prev) =>
                            prev.filter((i) => i.id !== a.id)
                          )
                        }
                        title="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div key={a.id} className="chat-preview-file">
                      <span className="chat-preview-file-name" title={a.name}>
                        {a.name}
                      </span>
                      <span className="chat-preview-file-size">
                        {(a.size / 1024).toFixed(1)} KB
                      </span>
                      <button
                        className="chat-preview-remove"
                        onClick={() =>
                          setPendingAttachments((prev) =>
                            prev.filter((i) => i.id !== a.id)
                          )
                        }
                        title="移除附件"
                      >
                        ×
                      </button>
                    </div>
                  )
                )}
              </div>
            )}
            <textarea
              className="chat-input"
              placeholder="输入消息，可直接粘贴图片…（Enter 发送，Shift+Enter 换行）"
              rows={3}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
            />
            <div className="chat-input-actions">
              <button
                className="chat-attach-btn"
                onClick={() => fileInputRef.current?.click()}
                title="上传附件（图片 / 文本类文件）"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={handlePickFiles}
              />
              <select
                className="config-input chat-model-select"
                value={currentModelId}
                onChange={(e) => void handleModelChange(e.target.value)}
                disabled={!activeConv || models.length === 0}
                title="当前对话使用的模型"
              >
                {models.length === 0 && <option value="">未配置模型</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.model || "未命名模型"}
                  </option>
                ))}
              </select>
              <button
                className="config-add-path-btn"
                disabled={sending}
                onClick={() => void handleSend()}
              >
                {sending ? "思考中…" : "发送"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
