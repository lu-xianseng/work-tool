import { invoke, Channel } from "@tauri-apps/api/core";

/** 一条对话消息。字段与后端 chat::ChatMessage（camelCase）一致。 */
export interface ChatMessage {
  id: string;
  /** "user" | "assistant" */
  role: string;
  /** 纯文本；粘贴的图片以 markdown `![图片](data:...)` 内嵌 */
  content: string;
  createdAt: number;
}

/** 一条对话。数据模型与需求文档保持一致。 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** 绑定的模型 id（模型列表中的一项）；旧数据缺失时为空串，发送时回退到第一个模型 */
  modelId?: string;
}

/** 一个 AI 模型配置（NEW-API，OpenAI 兼容接口）。 */
export interface AiModel {
  id: string;
  /** 展示名称，如「主力模型」「备用」 */
  name: string;
  /** 服务地址，如 https://your-new-api.example.com */
  baseUrl: string;
  apiKey: string;
  /** 模型名，如 gpt-4o-mini */
  model: string;
}

/** 流式回复事件（与后端 chat::ChatStreamEvent 对应）。 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; fullText: string }
  | { type: "error"; message: string };

/**
 * 对话功能的 invoke 封装。
 * 所有文件读写与 AI 调用都在 Rust 侧完成，前端只发 IPC。
 */
export const chatApi = {
  getAiModels: () => invoke<AiModel[]>("get_ai_models"),
  saveAiModels: (models: AiModel[]) =>
    invoke<void>("save_ai_models", { models }),

  listConversations: () => invoke<Conversation[]>("list_conversations"),
  createConversation: () => invoke<Conversation>("create_conversation"),
  getConversation: (conversationId: string) =>
    invoke<Conversation>("get_conversation", { conversationId }),
  getActiveConversationId: () => invoke<string>("get_active_conversation_id"),
  setActiveConversation: (conversationId: string) =>
    invoke<void>("set_active_conversation", { conversationId }),
  /** 绑定对话使用的模型 id */
  setConversationModel: (conversationId: string, modelId: string) =>
    invoke<void>("set_conversation_model", { conversationId, modelId }),
  /** 重命名对话，返回最终标题 */
  renameConversation: (conversationId: string, title: string) =>
    invoke<string>("rename_conversation", { conversationId, title }),
  deleteConversation: (conversationId: string) =>
    invoke<Conversation[]>("delete_conversation", { conversationId }),

  addMessage: (conversationId: string, role: string, content: string) =>
    invoke<ChatMessage>("add_message", { conversationId, role, content }),

  /**
   * 流式调用 AI（SSE）。增量文本通过 channel 下发：
   * delta → 追加显示；done 携带完整回复（保存 assistant 消息用）；error 为流中途错误。
   */
  streamChat: (conversationId: string, channel: Channel<ChatStreamEvent>) =>
    invoke<void>("stream_chat", { conversationId, channel }),

  /** 根据对话首条用户消息，用 AI 生成对话标题并保存，返回新标题 */
  generateConversationTitle: (conversationId: string) =>
    invoke<string>("generate_conversation_title", { conversationId }),
};

/** 本地回退标题：去掉图片 markdown 后取前 N 个字符。 */
export function makeLocalTitle(content: string, max = 20): string {
  const text = content
    .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "新对话";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
