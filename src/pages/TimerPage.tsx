import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 与后端 timer::TaskItem 对应 */
interface TaskItem {
  id: number;
  action: string;
  hour: number;
  minute: number;
  loop_type: string;
  day: string;
}

/** 与后端 timer::TaskOutcome 对应：affected 为受影响记录数，warning 为非致命问题 */
interface TaskOutcome {
  affected: number;
  warning: string;
}

/** 与后端 timer::NextTask 对应 */
interface NextTask {
  /** 下一次触发时刻的 epoch 秒 */
  epoch: number;
  action: string;
}

const ACTION_LABELS: Record<string, string> = {
  shutdown: "关机",
  reboot: "重启",
};

const LOOP_LABELS: Record<string, string> = {
  "1": "每天",
  "2": "每周",
  "3": "每月",
};

const WEEK_OPTIONS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => `${i + 1}日`);

/** 倒计时重新拉取的间隔：本地每秒推进，定期校准后端数据，避免任务被外部改动后长期不准 */
const NEXT_TASK_SYNC_MS = 15_000;

const pad2 = (n: number): string => String(n).padStart(2, "0");

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/**
 * 把剩余秒数格式化为「3天2小时5分钟」。
 * 与后端 next_task 的口径一致：高位为 0 时省略，全部为 0 时至少显示「0秒」。
 */
function formatRemaining(deltaSec: number): string {
  const delta = Math.max(0, Math.floor(deltaSec));
  const days = Math.floor(delta / 86400);
  const hours = Math.floor((delta % 86400) / 3600);
  const minutes = Math.floor((delta % 3600) / 60);
  const secs = delta % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0) parts.push(`${minutes}分钟`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);
  return parts.join("");
}

interface TimerPageProps {
  onToast: (message: string) => void;
  /** 需要用户明确知晓的问题（如计划任务注册失败），走弹窗而非一闪而过的 toast */
  onError: (title: string, message: string) => void;
  onConfirm: (title: string, message: string, onOk: () => void) => void;
  /** 右上角「添加任务」入口：切换到 TimerAddPage 子页 */
  onOpenAdd: () => void;
}

/**
 * 定时任务列表页：倒计时 + 任务表格 + 清空全部。
 * 添加任务已拆到 TimerAddPage（右上角齿轮进入），本页只负责展示与删除。
 */
export function TimerPage({ onToast, onError, onConfirm, onOpenAdd }: TimerPageProps) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [next, setNext] = useState<NextTask | null>(null);
  /** 每秒推进一次，用于本地渲染倒计时，不必每秒发 IPC */
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadTasks = async () => {
    try {
      setTasks(await invoke<TaskItem[]>("get_all_tasks"));
    } catch (e) {
      onError("出错了", `加载任务列表失败: ${e}`);
    }
  };

  const loadNext = async () => {
    try {
      setNext(await invoke<NextTask | null>("next_task"));
    } catch {
      // 倒计时只是辅助信息，拉取失败时保持旧值即可，不打扰用户
    }
  };

  useEffect(() => {
    void loadTasks();
    void loadNext();

    const tick = window.setInterval(() => setNowMs(Date.now()), 1000);
    const sync = window.setInterval(() => void loadNext(), NEXT_TASK_SYNC_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(sync);
    };
  }, []);

  const handleDelete = (task: TaskItem) => {
    onConfirm(
      "删除任务",
      `确定要删除这条${actionLabel(task.action)}任务吗？\n${pad2(task.hour)}:${pad2(task.minute)} ${LOOP_LABELS[task.loop_type] ?? ""}${task.day ? ` ${task.day}` : ""}`,
      async () => {
        try {
          const outcome = await invoke<TaskOutcome>("delete_task", {
            taskId: task.id,
          });
          if (outcome.warning) {
            onError("任务已删除，但有异常", outcome.warning);
          } else {
            onToast("任务已删除");
          }
          await Promise.all([loadTasks(), loadNext()]);
        } catch (e) {
          onError("出错了", `删除失败: ${e}`);
        }
      }
    );
  };

  const handleClearAll = () => {
    if (tasks.length === 0) {
      onToast("当前没有任务");
      return;
    }
    onConfirm(
      "清空确认",
      `确定要清空全部 ${tasks.length} 条定时任务吗？\n系统计划任务会一并移除。`,
      async () => {
        try {
          const outcome = await invoke<TaskOutcome>("clear_all_tasks");
          if (outcome.warning) {
            onError("任务已清空，但有异常", outcome.warning);
          } else {
            onToast(`已清空 ${outcome.affected} 条任务`);
          }
          await Promise.all([loadTasks(), loadNext()]);
        } catch (e) {
          onError("出错了", `清空失败: ${e}`);
        }
      }
    );
  };

  const remainingText = next
    ? `${formatRemaining(next.epoch - nowMs / 1000)} 后${actionLabel(next.action)}`
    : "";

  return (
    <>
      <div className="settings-header">
        <h2>定时重启和关机</h2>
        <button
          className="settings-btn"
          onClick={onOpenAdd}
          title="添加任务"
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

      <div className="card">
        <div className="countdown-box">
          {next ? (
            <>
              <span className="countdown-label">距离下一次任务</span>
              <span className="countdown-text">{remainingText}</span>
            </>
          ) : (
            <span className="countdown-empty">暂无定时任务</span>
          )}
        </div>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>动作</th>
              <th>时间</th>
              <th>循环</th>
              <th>日</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td colSpan={5} className="timer-empty-cell">
                  暂无定时任务
                </td>
              </tr>
            )}
            {tasks.map((task) => (
              <tr key={task.id}>
                <td>{actionLabel(task.action)}</td>
                <td>
                  {pad2(task.hour)}:{pad2(task.minute)}
                </td>
                <td>{LOOP_LABELS[task.loop_type] ?? task.loop_type}</td>
                <td>{task.day || "-"}</td>
                <td className="action-cell">
                  <div className="action-btns">
                    <button
                      className="stop-btn"
                      onClick={() => handleDelete(task)}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="timer-form-actions">
          <button className="config-delete-btn" onClick={handleClearAll}>
            清空全部
          </button>
        </div>
      </div>
    </>
  );
}

interface TimerAddPageProps {
  onToast: (message: string) => void;
  onError: (title: string, message: string) => void;
  /** 点「返回」：不保存，直接丢弃表单回到列表 */
  onCancel: () => void;
  /** 点「保存」且任务已入库：回到列表并触发刷新 */
  onSaved: () => void;
}

/**
 * 定时任务添加页（右上角齿轮进入）。
 * 与进程管理配置页不同：返回**不**自动保存，必须主动点「保存」才会写入任务。
 * 表单状态是组件本地的，返回即丢弃，符合「不保存」的语义。
 */
export function TimerAddPage({
  onToast,
  onError,
  onCancel,
  onSaved,
}: TimerAddPageProps) {
  // 默认时间 = 当前时间 +1 小时（沿用原项目）
  const [time, setTime] = useState(() => {
    const d = new Date(Date.now() + 3600_000);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  });
  const [action, setAction] = useState("shutdown");
  const [loopType, setLoopType] = useState("1");
  const [day, setDay] = useState("");

  /** 循环类型切换时，日期选项的含义会变，必须同步换成该类型的合法默认值 */
  const handleLoopChange = (value: string) => {
    setLoopType(value);
    if (value === "2") setDay(WEEK_OPTIONS[0]);
    else if (value === "3") setDay(MONTH_OPTIONS[0]);
    else setDay("");
  };

  const handleSave = async () => {
    if (!time) {
      onToast("请选择时间");
      return;
    }
    const [hour, minute] = time.split(":").map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      onToast("时间格式不正确");
      return;
    }

    const params = { hour, minute, action, loopType, day };
    try {
      // 后端按任务名注册计划任务，同规则会互相覆盖，所以先在清单层面去重
      const exists = await invoke<boolean>("exists_task", params);
      if (exists) {
        onError("无法添加", "该任务已存在");
        return;
      }

      const outcome = await invoke<TaskOutcome>("add_task", params);
      if (outcome.warning) {
        // 任务已入库但计划任务可能没注册上，到点不会触发，必须让用户看到
        onError("任务已添加，但有异常", outcome.warning);
      } else {
        onToast("任务添加成功");
      }
      // 无论有无 warning，任务都已入库，回到列表刷新
      onSaved();
    } catch (e) {
      onError("出错了", `添加任务失败: ${e}`);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="back-btn" onClick={onCancel} title="返回（不保存）">
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
        <span className="settings-hint"></span>
      </div>

      <div className="card">
        <div className="config-add-section">
          <h4>添加任务</h4>
          <div className="timer-form">
            <div className="timer-form-row">
              <label className="timer-form-label">时间</label>
              <input
                type="time"
                className="config-input timer-form-control"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>

            <div className="timer-form-row">
              <label className="timer-form-label">动作</label>
              <select
                className="config-input timer-form-control"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              >
                <option value="shutdown">关机</option>
                <option value="reboot">重启</option>
              </select>
            </div>

            <div className="timer-form-row">
              <label className="timer-form-label">循环</label>
              <select
                className="config-input timer-form-control"
                value={loopType}
                onChange={(e) => handleLoopChange(e.target.value)}
              >
                <option value="1">每天</option>
                <option value="2">每周</option>
                <option value="3">每月</option>
              </select>
            </div>

            {loopType !== "1" && (
              <div className="timer-form-row">
                <label className="timer-form-label">
                  {loopType === "2" ? "星期" : "日期"}
                </label>
                <select
                  className="config-input timer-form-control"
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                >
                  {(loopType === "2" ? WEEK_OPTIONS : MONTH_OPTIONS).map(
                    (opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    )
                  )}
                </select>
              </div>
            )}
          </div>

          <div className="timer-form-actions">
            <button className="config-add-path-btn" onClick={handleSave}>
              添加任务
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
