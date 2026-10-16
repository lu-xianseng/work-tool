import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAutoWindowHeight, type OverlayTarget } from "./useAutoWindowHeight";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { ProcessPage, type ProcessPageHandle } from "./pages/ProcessPage";
import { TimerPage, TimerAddPage } from "./pages/TimerPage";
import { AboutPage } from "./pages/AboutPage";
import { ChatPage } from "./pages/ChatPage";
import "./App.css";

/** 侧边栏的四个功能页 */
type PageKey = "process" | "timer" | "chat" | "about";

/** AI 对话页最低内容高度（逻辑像素），低于该值时切到对话页自动放大一次 */
const CHAT_MIN_HEIGHT = 640;

/**
 * 导航项。图标在侧边栏收起时是唯一可辨识的信息，因此必须始终提供，
 * 不能只靠文字标签 —— 否则收起后就无法判断该点哪一项。
 */
const NAV_ITEMS: { key: PageKey; label: string; icon: ReactNode }[] = [
  {
    key: "process",
    label: "进程管理",
    icon: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  },
  {
    key: "timer",
    label: "定时重启和关机",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
  },
  {
    key: "chat",
    label: "AI 对话",
    icon: <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />,
  },
  {
    key: "about",
    label: "关于",
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16v-4M12 8h.01" />
      </>
    ),
  },
];

type ModalKind = "confirm" | "error";

interface ModalState {
  kind: ModalKind;
  title: string;
  message: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

interface ToastItem {
  id: number;
  message: string;
}

export function App() {
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [toastId, setToastId] = useState(0);

  /** 当前侧边栏选中的功能页 */
  const [page, setPage] = useState<PageKey>("process");
  /** 侧边栏是否收起。收起后只留一条窄边用于展开，把横向空间让给内容区 */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  /**
   * 定时任务的「添加任务」子页。
   * 返回即丢弃（不保存），必须主动点「保存」才会写入。
   */
  const [showTimerAdd, setShowTimerAdd] = useState(false);
  /** 进程详情浮层显示期间暂停窗口高度自适应（瞬时 fixed 浮层会与高度调整互相放大） */
  const [heightPaused, setHeightPaused] = useState(false);
  /** 进程设置页内路径弹窗是否打开（fixed 弹窗需单独测量，供高度自适应观察） */
  const [pathModalOpen, setPathModalOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const modalBoxRef = useRef<HTMLDivElement>(null);
  const pathModalBoxRef = useRef<HTMLDivElement>(null);
  /** 弹窗按钮引用：用于键盘焦点循环（Tab 在 确定/取消 间切换） */
  const modalOkRef = useRef<HTMLButtonElement>(null);
  const modalCancelRef = useRef<HTMLButtonElement>(null);
  /** 进程页的保存句柄：设置页打开时，切走前必须先落盘，失败则留在原处 */
  const processRef = useRef<ProcessPageHandle>(null);

  const overlays: OverlayTarget[] = [
    { ref: modalBoxRef, open: modal !== null },
    { ref: pathModalBoxRef, open: pathModalOpen },
  ];
  // 窗口高度跟随内容自适应（含两个 fixed 弹窗，它们不参与文档流需单独测量）
  // tooltip 是瞬时浮层，显示期间暂停高度自适应，避免窗口被撑高后位置漂移
  // AI 对话页激活时也暂停：chat 布局撑满窗口、输入框贴底，
  // 窗口高度由用户手动拉伸控制，不与内容自适应打架
  useAutoWindowHeight(containerRef, overlays, page === "chat" || heightPaused);

  // AI 对话页最低内容高度：默认启动页是进程管理，首帧自适应会把窗口缩回
  // 内容高度（约 350），而对话页激活时高度自适应暂停（布局撑满窗口、输入框
  // 贴底），若不补一次，对话页就一直是压缩后的小窗口。
  // 仅在「切换进入对话页」且当前高度低于该值时放大一次；之后用户手动拉伸
  // 窗口高度完全由用户控制；最大化 / 全屏时跳过，不与用户意图打架。
  useEffect(() => {
    if (page !== "chat") return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        if ((await win.isMaximized()) || (await win.isFullscreen())) return;
        const [outer, inner, scaleFactor] = await Promise.all([
          win.outerSize(),
          win.innerSize(),
          win.scaleFactor(),
        ]);
        const chrome = (outer.height - inner.height) / scaleFactor;
        const contentH = inner.height / scaleFactor - chrome;
        if (contentH < CHAT_MIN_HEIGHT) {
          if (cancelled) return;
          await win.setSize(
            new LogicalSize(inner.width / scaleFactor, CHAT_MIN_HEIGHT + chrome)
          );
        }
      } catch (e) {
        console.warn("对话页高度对齐失败:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [page]);

  // 以下处理器全部用 useCallback 保持稳定：
  // 子页面（如 ChatPage）的加载 effect 依赖 onError 等 props，若每次渲染都换新引用，
  // App 一重渲染（如 toast 出现）就会让子页重新加载/重置状态。
  const showToast = useCallback(
    (message: string) => {
      const id = toastId + 1;
      setToastId(id);
      setToasts((prev) => [...prev, { id, message }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 2000);
    },
    [toastId]
  );

  // 供各页面复用的弹窗能力：App 统一持有 modal 状态，页面只需按需调用
  // onCancel 可选：技能脚本执行等场景需要在用户取消时恢复流程
  const showConfirm = useCallback(
    (title: string, message: string, onOk: () => void, onCancel?: () => void) => {
      setModal({ kind: "confirm", title, message, onConfirm: onOk, onCancel });
    },
    []
  );

  const showError = useCallback((title: string, message: string) => {
    setModal({ kind: "error", title, message });
  }, []);

  const closeModal = useCallback(() => {
    setModal(null);
  }, []);

  // 弹窗键盘支持：打开时焦点移入主按钮；
  // Enter=确定（焦点在取消上则取消）、Esc=取消、Tab 在两按钮间循环。
  // 用捕获阶段监听，确保弹窗打开期间输入框等底层控件收不到回车，避免误触发发送。
  useEffect(() => {
    if (!modal) return;
    modalOkRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeModal();
        modal.onCancel?.();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement === modalCancelRef.current) {
          closeModal();
          modal.onCancel?.();
        } else {
          closeModal();
          modal.onConfirm?.();
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const active = document.activeElement;
        if (active === modalOkRef.current && modalCancelRef.current) {
          modalCancelRef.current.focus();
        } else {
          modalOkRef.current?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [modal, closeModal]);

  /**
   * 侧边栏切换功能页。
   * 进程管理的设置子页切走之前先沿用「返回即保存」把配置落盘，失败则留在原处；
   * 定时任务的添加子页相反 —— 返回不保存，因此切页直接关闭，未保存的表单按用户预期丢弃。
   */
  const handleNav = async (key: PageKey) => {
    if (key === page) return;
    if (page === "process") {
      const saved = await processRef.current?.saveAndBack();
      if (saved === false) return;
    }
    setShowTimerAdd(false);
    setPage(key);
  };

  // 全局禁用右键菜单（桌面工具类应用），全应用生命周期生效
  useEffect(() => {
    const disableContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };
    document.addEventListener("contextmenu", disableContextMenu);
    return () => {
      document.removeEventListener("contextmenu", disableContextMenu);
    };
  }, []);

  return (
    <div
      className={
        page === "chat" ? "container app-shell container-wide" : "container app-shell"
      }
      // AI 对话页激活时容器高度=窗口视口，flex 链才有确定基准：
      // 消息区在内部滚动、输入框贴底；overflow 隐藏防止任何意外溢出产生页面滚动
      style={
        page === "chat"
          ? { height: "100vh", overflow: "hidden" }
          : undefined
      }
      ref={containerRef}
    >
      <div className="toast-list">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.message}
          </div>
        ))}
      </div>

      <aside className={sidebarCollapsed ? "sidebar sidebar-collapsed" : "sidebar"}>
        {/* 收起后标题放不下，改为只显示首字母，避免出现被截断的半截文字 */}
        <div className="sidebar-brand" title="">
          {sidebarCollapsed ? "" : ""}
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              // 设置页/添加页是所属功能的子页，此时仍高亮该功能项，
              // 否则侧边栏会没有选中态，用户看不出自己在哪个功能下
              className={
                item.key === page ? "nav-item nav-item-active" : "nav-item"
              }
              onClick={() => void handleNav(item.key)}
              // 收起时没有文字，必须靠 title 说明这一项是什么
              title={item.label}
            >
              <svg
                className="nav-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {item.icon}
              </svg>
              {!sidebarCollapsed && <span>{item.label}</span>}
            </button>
          ))}
        </nav>

        <button
          className="sidebar-toggle"
          onClick={() => setSidebarCollapsed((v) => !v)}
          title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
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
            {sidebarCollapsed ? (
              <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />
            ) : (
              <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
            )}
          </svg>
          {!sidebarCollapsed && <span>收起</span>}
        </button>
      </aside>

      <div className="page-main">
        {/* 添加页自带「返回」头部，其余页面（含各自的标题栏）由各页面组件渲染 */}
        {page === "timer" && showTimerAdd ? (
          <TimerAddPage
            onToast={showToast}
            onError={showError}
            onCancel={() => setShowTimerAdd(false)}
            onSaved={() => setShowTimerAdd(false)}
          />
        ) : (
          <>
            {page === "process" && (
              <ProcessPage
                ref={processRef}
                onToast={showToast}
                onError={showError}
                onConfirm={showConfirm}
                pathModalRef={pathModalBoxRef}
                onHoverChange={setHeightPaused}
                onPathModalChange={setPathModalOpen}
              />
            )}
            {page === "timer" && (
              <TimerPage
                onToast={showToast}
                onError={showError}
                onConfirm={showConfirm}
                onOpenAdd={() => setShowTimerAdd(true)}
              />
            )}
            {page === "about" && <AboutPage />}
          </>
        )}
        {/*
          AI 对话页保持常驻（切走时仅隐藏、不卸载）：
          流式输出期间切到其他页面，返回后能继续看到增量输出，
          而不是重新加载出已保存的完整回复。display:none 不占布局，
          窗口高度自适应只按当前可见页面测量。
        */}
        <div
          className="chat-keepalive"
          style={{ display: page === "chat" ? undefined : "none" }}
        >
          <ChatPage
            onToast={showToast}
            onError={showError}
            onConfirm={showConfirm}
          />
        </div>
      </div>

      {modal && (
        <div className="modal-mask" onClick={closeModal}>
          <div
            className="modal-box"
            ref={modalBoxRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">{modal.title}</div>
            <div className="modal-message">{modal.message}</div>
            <div className="modal-actions">
              {modal.kind === "confirm" ? (
                <>
                  <button
                    ref={modalCancelRef}
                    className="modal-btn modal-btn-secondary"
                    onClick={() => {
                      closeModal();
                      modal.onCancel?.();
                    }}
                  >
                    取消
                  </button>
                  <button
                    ref={modalOkRef}
                    className="modal-btn modal-btn-primary"
                    onClick={() => {
                      closeModal();
                      modal.onConfirm?.();
                    }}
                  >
                    确定
                  </button>
                </>
              ) : (
                <button
                  ref={modalOkRef}
                  className="modal-btn modal-btn-primary"
                  onClick={closeModal}
                >
                  确定
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
