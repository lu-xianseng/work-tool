import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type Ref,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ElementRef } from "../useAutoWindowHeight";

/** 与后端进程分组数据对应 */
interface AppItem {
  name: string;
  pid: number;
  paths: string[];
  cpu: number;
  memory: number;
  /** 分组内进程总数（含子进程），0 表示未运行 */
  process_count: number;
}

/** 与后端应用配置（apps.ini）对应 */
interface AppConfigItem {
  name: string;
  paths: string[];
}

interface ProcessDetail {
  pid: number;
  /** 进程树深度，0 为主进程，仅用于缩进体现层级 */
  depth: number;
  name: string;
  /** 已按逻辑核心数归一化，组内各进程之和等于主行整组占用 */
  cpu: number;
  /** 工作集（字节） */
  memory: number;
}

/**
 * 鼠标离开后延迟隐藏的时间（毫秒）。
 * 进程较多时浮层需要滚动查看，立即隐藏会让鼠标来不及移入浮层。
 */
const HIDE_DELAY_MS = 260;
/** 悬停浮层的固定宽度（px）：只展示四列，无需过宽 */
const POVER_WIDTH = 340;
/** 浮层与视口边缘的最小间距（px） */
const POVER_MARGIN = 12;
/** 浮层与徽标之间的间距（px） */
const POVER_GAP = 6;
/** 内容上限高度（px），实际高度还会被视口可用空间进一步压缩 */
const POVER_MAX_HEIGHT = 360;
/**
 * 浮层最小高度（px）。
 * 窗口很矮时可用空间可能只有几十像素，若不设下限浮层会被压成一条缝、几乎不可用；
 * 此时宁可让它略微超出视口边界，也保留基本的可读性。
 */
const POVER_MIN_HEIGHT = 120;

function formatMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 进程页向外层暴露的强制操作句柄。
 * 侧边栏切走时由外层调用：设置页打开时先「返回即保存」落盘，失败则留在原处。
 */
export interface ProcessPageHandle {
  /**
   * 返回主列表并保存配置。
   * - 不在设置页：立即成功，不产生任何写入。
   * - 配置尚未加载完成：关闭设置页但返回 false（避免误以为已保存；外层据此阻断切页）。
   * - 保存失败：停留在设置页，返回 false。
   * @returns 是否已成功落盘
   */
  saveAndBack: () => Promise<boolean>;
}

interface ProcessPageProps {
  onToast: (message: string) => void;
  /** 需要用户明确知晓的问题，走弹窗而非一闪而过的 toast */
  onError: (title: string, message: string) => void;
  /** 二次确认弹窗（由 App 统一持有 modal 状态） */
  onConfirm: (title: string, message: string, onOk: () => void) => void;
  /**
   * 设置页内路径管理弹窗的内容盒 ref。
   * 弹窗是 position:fixed、不参与文档流，需由外层窗口高度自适应 hook 单独观察。
   */
  pathModalRef: ElementRef<HTMLDivElement>;
  /** 进程详情浮层显示期间通知外层暂停窗口高度自适应（瞬时浮层会与高度调整互相放大） */
  onHoverChange: (active: boolean) => void;
  /** 路径弹窗开关同步给外层，供窗口高度自适应观察 */
  onPathModalChange: (open: boolean) => void;
  ref?: Ref<ProcessPageHandle>;
}

/**
 * 进程管理页：主表格（按主程序分组展示 CPU/内存）+ 设置子页（应用与清理路径配置）。
 * 设置子页的开关是本组件内部状态，返回/切走均需走 saveAndBack 落盘。
 */
export function ProcessPage({
  onToast,
  onError,
  onConfirm,
  pathModalRef,
  onHoverChange,
  onPathModalChange,
  ref,
}: ProcessPageProps) {
  const [apps, setApps] = useState<AppItem[]>([]);
  const [status, setStatus] = useState("");
  /** 是否显示设置子页。返回即保存，因此不提供独立保存按钮 */
  const [showSettings, setShowSettings] = useState(false);
  const [configApps, setConfigApps] = useState<AppConfigItem[]>([]);
  const [newAppName, setNewAppName] = useState("");
  /**
   * 配置是否已成功从后端加载。
   * configApps 初始为空数组，且 loadConfig() 是异步的；
   * 若在加载完成前触发保存，会把 apps.ini 整个写空。
   * 由于「返回即保存」是必经路径，必须有这个标志把守。
   */
  const [configLoaded, setConfigLoaded] = useState(false);

  const [pathModalOpen, setPathModalOpen] = useState(false);
  const [pathModalIdx, setPathModalIdx] = useState<number | null>(null);
  const [newPathInput, setNewPathInput] = useState("");

  // 进程数徽标的悬停详情
  const [hover, setHover] = useState<{
    name: string;
    /** 徽标的视口坐标：bottom 用于向下展开，top 用于空间不足时向上翻转 */
    anchor: { top: number; bottom: number; left: number };
  } | null>(null);
  const [details, setDetails] = useState<ProcessDetail[] | null>(null);
  const [detailError, setDetailError] = useState("");
  // 递增序号：用于丢弃过期的异步响应，避免快速划过多个应用时数据串行
  const hoverSeq = useRef(0);
  // 延迟隐藏计时器：给鼠标从徽标移入浮层留出时间，否则浮层无法滚动/复制
  const hideTimer = useRef(0);

  const cancelHide = () => {
    if (hideTimer.current) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = 0;
    }
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(() => {
      hoverSeq.current++; // 使在途请求失效
      setHover(null);
      setDetails(null);
      setDetailError("");
    }, HIDE_DELAY_MS);
  };

  // 卸载时清理计时器，避免对已卸载组件 setState
  useEffect(() => cancelHide, []);

  /**
   * 悬停到进程数徽标上时拉取整组进程详情。
   * 锚点用徽标当时的视口坐标：浮层是 fixed 定位，
   * 坐标必须在鼠标进入的瞬间取好，否则浮层出现后 DOM 变化会导致位置不准。
   */
  const handleBadgeEnter = async (
    name: string,
    e: ReactMouseEvent<HTMLElement>
  ) => {
    cancelHide();
    const rect = e.currentTarget.getBoundingClientRect();
    const seq = ++hoverSeq.current;

    setHover({
      name,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
    });
    // 切换目标时先清空旧数据，避免显示上一个应用的内容
    setDetails(null);
    setDetailError("");

    try {
      const list = await invoke<ProcessDetail[]>("get_app_process_details", {
        name,
      });
      // 鼠标已经移开或移到别的应用上了，这次结果作废
      if (seq !== hoverSeq.current) return;
      setDetails(list);
    } catch (err) {
      if (seq !== hoverSeq.current) return;
      setDetailError(String(err));
    }
  };

  /** 徽标与浮层共用：离开时延迟隐藏，留出移入浮层的时间 */
  const handleHoverLeave = () => {
    scheduleHide();
  };

  const refresh = async () => {
    try {
      const list = await invoke<AppItem[]>("get_app_list");
      setApps(list);
      setStatus("");
    } catch (e) {
      setStatus(`刷新失败: ${e}`);
    }
  };

  const copyPid = async (pid: number) => {
    try {
      await writeText(String(pid));
      onToast("PID 已复制");
    } catch (e) {
      console.error("复制失败:", e);
      onToast(`复制失败: ${e}`);
    }
  };

  const killApp = (name: string, processCount: number) => {
    onConfirm(
      "结束进程",
      `确定要结束 ${name} 吗？\n这将同时结束它的 ${processCount} 个进程（含子进程）。`,
      async () => {
        try {
          const msg = await invoke<string>("kill_app", { name });
          onToast(msg);
          await refresh();
        } catch (e) {
          onError("错误", `结束进程失败: ${e}`);
        }
      }
    );
  };

  const initApp = (name: string) => {
    onConfirm(
      "初始化确认",
      `确定要初始化 ${name} 吗？\n这会删除配置中的文件/目录。`,
      async () => {
        try {
          const msg = await invoke<string>("initialize_app", { name });
          onToast(msg);
          await refresh();
        } catch (e) {
          onError("错误", `初始化失败: ${e}`);
        }
      }
    );
  };

  const loadConfig = async () => {
    try {
      const list = await invoke<AppConfigItem[]>("get_app_config");
      setConfigApps(list);
      // 只有加载成功才置为 true：失败时 configApps 仍是旧值/空数组，
      // 此时绝不能写回文件（详见 saveAndBack）
      setConfigLoaded(true);
    } catch (e) {
      onToast(`加载配置失败: ${e}`);
    }
  };

  /**
   * 返回主页面（设置页的「返回」按钮与侧边栏切走共用）。
   * 返回即保存：把当前配置写回 apps.ini 再退出。
   * 保存失败时停留在设置页，避免用户误以为改动已生效而丢失编辑内容。
   */
  const saveAndBack = async (): Promise<boolean> => {
    // 不在设置页时无需保存
    if (!showSettings) return true;

    // 配置尚未加载完成（或加载失败）时跳过写入。
    // 此时 configApps 还是初始空数组，直接保存会把 apps.ini 整个写空 ——
    // 「返回」是必经路径，撞上加载窗口的概率远高于原来的「保存」按钮。
    // 注意不能改用 configApps.length 判断：用户确实可能删光所有应用，
    // 那种情况下的空数组是合法结果，必须保存。
    if (!configLoaded) {
      onToast("配置尚未加载完成，本次未保存");
      setShowSettings(false);
      return false;
    }

    try {
      await invoke("save_app_config", { apps: configApps });
      setShowSettings(false);
      await refresh();
      return true;
    } catch (e) {
      onToast(`保存失败: ${e}`);
      return false;
    }
  };

  useEffect(() => {
    if (showSettings) {
      // 每次进入都重置，避免上一次的 true 让本轮加载失败时仍被当作可保存
      setConfigLoaded(false);
      loadConfig();
    }
  }, [showSettings]);

  useEffect(() => {
    refresh();

    const unlisten = listen<AppItem[]>("app-updated", (event) => {
      setApps(event.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // 浮层/弹窗开关同步给外层，供窗口高度自适应观察
  useEffect(() => {
    onHoverChange(hover !== null);
  }, [hover, onHoverChange]);

  useEffect(() => {
    onPathModalChange(pathModalOpen);
  }, [pathModalOpen, onPathModalChange]);

  // 离开本页时复位外层的观察状态
  useEffect(
    () => () => {
      onHoverChange(false);
      onPathModalChange(false);
    },
    [onHoverChange, onPathModalChange]
  );

  // 不传依赖数组：每次渲染重建句柄，保证拿到的是最新闭包（configLoaded/configApps/showSettings）
  useImperativeHandle(ref, () => ({ saveAndBack }));

  const openPathModal = (idx: number) => {
    setPathModalIdx(idx);
    setNewPathInput("");
    setPathModalOpen(true);
  };

  const closePathModal = () => {
    setPathModalOpen(false);
    setPathModalIdx(null);
    setNewPathInput("");
  };

  const addPath = () => {
    if (!newPathInput.trim() || pathModalIdx === null) return;
    setConfigApps((prev) =>
      prev.map((a, i) =>
        i === pathModalIdx
          ? { ...a, paths: [...a.paths, newPathInput.trim()] }
          : a
      )
    );
    setNewPathInput("");
  };

  const removePath = (pathIdx: number) => {
    if (pathModalIdx === null) return;
    setConfigApps((prev) =>
      prev.map((a, i) =>
        i === pathModalIdx
          ? { ...a, paths: a.paths.filter((_, j) => j !== pathIdx) }
          : a
      )
    );
  };

  // ===== 设置页面 =====
  // 注意：这里必须是 JSX 变量而不是内联组件函数。
  // 内联组件每次渲染都是新的类型，React 会卸载并重建整棵子树，
  // 导致输入框每敲一个字符就失焦。
  const settingsPage = (
    <div className="settings-page">
      <div className="settings-header">
        <button
          className="back-btn"
          onClick={saveAndBack}
          title="返回并保存配置"
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
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          <span style={{ marginLeft: 4, fontSize: 14 }}>返回</span>
        </button>
        <span className="settings-hint">返回时自动保存</span>
      </div>

      <div className="card">
        <div className="config-add-section">
          <h4>添加应用</h4>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="config-input"
              placeholder="应用名（如 WeChat）"
              value={newAppName}
              onChange={(e) => setNewAppName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newAppName.trim()) {
                  const name = newAppName.trim();
                  setConfigApps((prev) => {
                    if (prev.find((a) => a.name === name)) return prev;
                    return [...prev, { name, paths: [] }];
                  });
                  setNewAppName("");
                }
              }}
            />
            <button
              className="config-add-path-btn"
              onClick={() => {
                const name = newAppName.trim();
                if (!name) return;
                setConfigApps((prev) => {
                  if (prev.find((a) => a.name === name)) return prev;
                  return [...prev, { name, paths: [] }];
                });
                setNewAppName("");
              }}
            >
              添加
            </button>
          </div>
        </div>

        <div className="config-list">
          {configApps.length === 0 && (
            <p style={{ color: "#888", textAlign: "center", padding: 16 }}>
              暂无配置，请添加应用
            </p>
          )}
          {configApps.map((app, idx) => (
            <div key={`${app.name}-${idx}`} className="config-item">
              <div className="config-item-header">
                <span
                  className="config-app-name"
                  style={{ cursor: "pointer", color: "#4a9eff" }}
                  onClick={() => openPathModal(idx)}
                  title="点击管理清理路径"
                >
                  {app.name}
                  <span style={{ fontSize: 12, color: "#888", marginLeft: 6 }}>
                    {app.paths.length > 0
                      ? `(${app.paths.length} 条路径)`
                      : "（点击添加路径）"}
                  </span>
                </span>
                <button
                  className="config-delete-btn"
                  onClick={() => {
                    setConfigApps((prev) => prev.filter((_, i) => i !== idx));
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {pathModalOpen && pathModalIdx !== null && (
        <div className="modal-mask" onClick={closePathModal}>
          <div
            className="modal-box path-modal-box"
            ref={pathModalRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-title">
              管理路径 — {configApps[pathModalIdx]?.name}
            </div>
            <div className="modal-message" style={{ textAlign: "left" }}>
              <div className="path-add-row">
                <input
                  className="config-input path-add-input"
                  placeholder="输入清理目录路径"
                  value={newPathInput}
                  onChange={(e) => setNewPathInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addPath();
                  }}
                />
                <button
                  className="config-add-path-btn"
                  onClick={addPath}
                >
                  添加路径
                </button>
              </div>
              <div className="path-list">
                {configApps[pathModalIdx]?.paths.length === 0 && (
                  <p style={{ color: "#888", fontSize: 13 }}>暂无路径</p>
                )}
                {configApps[pathModalIdx]?.paths.map((p, pi) => (
                  <div key={pi} className="config-path-row">
                    <span style={{ flex: 1, wordBreak: "break-all" }}>{p}</span>
                    <button
                      className="path-remove-btn"
                      onClick={() => removePath(pi)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-secondary"
                onClick={closePathModal}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ===== 主表格页面 =====
  // 同上：用 JSX 变量，避免子树被重建
  const mainPage = (
    <div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>应用</th>
              <th title="分组内最早启动的进程（主进程）">PID</th>
              <th title="整组 CPU 占用，含所有子进程，已按核心数归一化">CPU</th>
              <th title="整组内存合计，含所有子进程">内存</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.name}>
                <td>
                  {app.name}
                  {app.pid !== 0 && app.process_count > 1 && (
                    <span
                      className="proc-count"
                      onMouseEnter={(e) => handleBadgeEnter(app.name, e)}
                      onMouseLeave={handleHoverLeave}
                    >
                      {app.process_count} 进程
                    </span>
                  )}
                </td>
                <td>
                  {app.pid === 0 ? (
                    "-"
                  ) : (
                    <span className="pid-cell">
                      {app.pid}
                      <button
                        className="copy-btn"
                        onClick={() => copyPid(app.pid)}
                        title="复制 PID"
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      </button>
                    </span>
                  )}
                </td>
                <td>{app.pid === 0 ? "-" : `${app.cpu.toFixed(1)}%`}</td>
                <td>{app.pid === 0 ? "-" : formatMemory(app.memory)}</td>
                <td className={app.pid === 0 ? "stopped" : "running"}>
                  {app.pid === 0 ? "已停止" : "运行中"}
                </td>
                <td className="action-cell">
                  <div className="action-btns">
                    {app.pid !== 0 && (
                      <button
                        className="stop-btn"
                        onClick={() => killApp(app.name, app.process_count)}
                      >
                        停止
                      </button>
                    )}
                    {/* 判断依据必须是 app.paths，不能是 configApps。
                        configApps 只服务于设置页，且仅在 showSettings 变 true 时才由
                        loadConfig() 异步填充；启动后它是空数组，会让所有「初始化」按钮
                        消失，直到用户进一次设置页再返回 —— 返回后状态残留才恢复显示。
                        app.paths 由后端在每次刷新时重新解析 apps.ini 得到（含 2s 推送），
                        启动即有值，且设置页保存后 refresh() 也能立刻同步。 */}
                    {app.paths.length > 0 && (
                      <button
                        className="init-btn"
                        onClick={() => initApp(app.name)}
                      >
                        初始化
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {status && <p className="status">{status}</p>}
    </div>
  );

  return (
    <>
      {showSettings ? (
        settingsPage
      ) : (
        <>
          <div className="settings-header">
            <h2>进程管理</h2>
            <button
              className="settings-btn"
              onClick={() => setShowSettings(true)}
              title="设置"
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
          {mainPage}
        </>
      )}

      {hover && (() => {
        // ── 水平：夹在视口内 ──
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = Math.min(
          Math.max(hover.anchor.left, POVER_MARGIN),
          Math.max(POVER_MARGIN, vw - POVER_WIDTH - POVER_MARGIN)
        );

        // ── 垂直：先算两侧真实可用空间，再决定方向与高度 ──
        // 这两个值已扣除间距与视口边距，是浮层真正能占用的高度
        const spaceBelow = vh - hover.anchor.bottom - POVER_GAP - POVER_MARGIN;
        const spaceAbove = hover.anchor.top - POVER_GAP - POVER_MARGIN;

        // 优先向下展开；放不下且上方更宽裕时才向上翻转
        const placeAbove =
          spaceBelow < POVER_MAX_HEIGHT && spaceAbove > spaceBelow;
        const available = placeAbove ? spaceAbove : spaceBelow;

        // 关键：高度必须同时受「可用空间」与「视口上限」约束。
        // 只按固定的 POVER_MAX_HEIGHT 撑开，在窗口较矮时会让浮层溢出视口，
        // 而溢出部分落在滚动容器之外，滚动条无法触达 —— 表现为内容显示不全且滚不动。
        const maxHeight = Math.min(
          Math.max(POVER_MIN_HEIGHT, available),
          Math.min(POVER_MAX_HEIGHT, vh - POVER_MARGIN * 2)
        );

        // 用 maxHeight 而非 height：进程少时浮层应随内容收缩，
        // 否则会撑到上限、底部留出一大片空白。
        // 内容超出时由 .proc-popover-scroll 的 flex:1 + min-height:0 接管滚动。
        const style: CSSProperties = {
          left,
          width: POVER_WIDTH,
          maxHeight,
          ...(placeAbove
            ? { bottom: vh - hover.anchor.top + POVER_GAP }
            : { top: hover.anchor.bottom + POVER_GAP }),
        };

        return (
          <div
            className="proc-popover"
            style={style}
            onMouseEnter={cancelHide}
            onMouseLeave={handleHoverLeave}
          >
            <div className="proc-popover-title">
              {hover.name}
              {details && ` — ${details.length} 个进程`}
            </div>

            {detailError && (
              <div className="proc-popover-error">{detailError}</div>
            )}

            {!detailError && !details && (
              <div className="proc-popover-loading">正在读取进程信息…</div>
            )}

            {details && (
              <div className="proc-popover-scroll">
                <table className="proc-table">
                  <thead>
                    <tr>
                      <th>PID</th>
                      <th>程序名称</th>
                      <th className="num">CPU</th>
                      <th className="num">内存</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map((p) => (
                      <tr key={p.pid} className={p.depth === 0 ? "is-main" : ""}>
                        <td className="num">{p.pid}</td>
                        <td>
                          {/* depth 只用于缩进体现父子层级，不作为独立展示字段 */}
                          <span style={{ paddingLeft: p.depth * 12 }}>
                            {p.depth > 0 && (
                              <span className="proc-tree-mark">└ </span>
                            )}
                            <span className="proc-name" title={p.name}>
                              {p.name}
                            </span>
                          </span>
                        </td>
                        <td className="num">{p.cpu.toFixed(1)}%</td>
                        <td className="num">{formatMemory(p.memory)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}
