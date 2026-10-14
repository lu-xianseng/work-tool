import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 倒计时总秒数（与原程序保持一致）
const COUNTDOWN_SECONDS = 60;

export default function App() {
  const [action, setAction] = useState("shutdown");
  const [ready, setReady] = useState(false);
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const [finished, setFinished] = useState(false);
  const timerRef = useRef(null);

  const appWindow = getCurrentWindow();
  const actionText = action === "reboot" ? "重启" : "关机";


  // 1. 拉取后端动作类型（shutdown / reboot），拿到后再启动倒计时
  useEffect(() => {
    let cancelled = false;
    invoke("get_confirm_action")
      .then((a) => {
        if (cancelled) return;
        setAction(a === "reboot" ? "reboot" : "shutdown");
        setReady(true);
      })
      .catch((e) => {
        console.error("获取动作类型失败:", e);
        if (!cancelled) setReady(true); // 兜底，用默认 shutdown
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. 倒计时：ready 之后每秒 -1，归 0 自动执行
  useEffect(() => {
    if (!ready || finished) return;

    timerRef.current = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          setFinished(true);
          // 倒计时结束，自动执行（catch 忽略：此时系统已开始关机/重启）
          invoke("execute_action", { action }).catch(() => {});
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [ready, finished, action]);

  // 立即执行
  const handleExecute = () => {
    if (finished) return;
    setFinished(true);
    clearInterval(timerRef.current);
    invoke("execute_action", { action }).catch(() => {});
  };

  // 取消（关闭窗口，进程退出）
  const handleCancel = () => {
    if (finished) return;
    setFinished(true);
    clearInterval(timerRef.current);
    invoke("window_close").catch(() => {});
  };

  // 标题栏拖动（点按钮时不触发拖动）
  const handleTitlebarMouseDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest("button")) return;
    appWindow.startDragging();
  };

  return (
    <div className="confirm-window">
      <div className="titlebar" onMouseDown={handleTitlebarMouseDown}>
        <span className="title">定时{actionText}</span>
        <button
          className="tb-close"
          onClick={handleCancel}
          title="取消并关闭"
        >
          ✕
        </button>
      </div>

      <div className="content">
        <div className="line">系统将在</div>
        <div className="countdown">{remaining}</div>
        <div className="line">秒后 {actionText}...</div>
      </div>

      <div className="buttons">
        <button className="btn btn-danger" onClick={handleExecute}>
          立即{actionText}
        </button>
        <button className="btn btn-success" onClick={handleCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
