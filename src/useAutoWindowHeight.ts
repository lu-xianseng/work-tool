import { useEffect, useRef } from "react";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

/**
 * 内容区（不含标题栏/边框）的最小逻辑高度。
 * 取 220 保证「结束进程 / 初始化确认」这类固定弹窗在任何情况下都不被裁切。
 */
const MIN_CONTENT_HEIGHT = 220;
/** 内容区硬性最大逻辑高度，避免窗口过长 */
const HARD_MAX_CONTENT_HEIGHT = 900;
/** 不超过屏幕可用高度的该比例 */
const VIEWPORT_RATIO = 0.92;
/** 高度差小于该值时不调整，避免亚像素抖动与无谓 IPC */
const HEIGHT_EPSILON = 1;

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 只读的 ref 形状。
 * React 的 RefObject<T> 中 current 是可变属性，赋值时需要双向兼容：
 * 把 RefObject<HTMLDivElement | null> 传给 RefObject<HTMLElement | null> 会失败。
 * 只读属性是协变的，因此这里用结构类型，让调用方能直接传具体元素的 ref。
 */
export type ElementRef<T extends HTMLElement = HTMLElement> = {
  readonly current: T | null;
};

export interface OverlayTarget {
  ref: ElementRef;
  open: boolean;
}

/**
 * 让窗口高度跟随页面内容自适应，宽度保持不变（尊重用户手动拉伸的宽度）。
 *
 * @param contentRef 页面最外层内容容器
 * @param overlays   浮层列表。浮层是 position:fixed、不参与文档流，容器高度测不到，
 *                   因此需要单独观察；ref 应挂在浮层的内容盒上（不是遮罩层，
 *                   遮罩层 inset:0 恒等于视口高度，测不出真实内容高度）。
 *
 * 实现要点：
 * 1. 用 getBoundingClientRect().height 测量，不能用 scrollHeight。
 *    scrollHeight 会被视口"托底"——窗口比内容高时测出的仍是视口高度，
 *    那样窗口只能变高、永远缩不回去。
 * 2. setSize 设的是窗口外部尺寸（含标题栏与边框），测到的是客户区高度，
 *    必须用 (outer - inner) / scaleFactor 求出 chrome 高度补偿，
 *    否则每次调整都少一截，多轮之后误差累积。
 * 3. lastApplied 记录上次请求的高度，变化不足 HEIGHT_EPSILON 就不发 IPC，
 *    同时切断「调窗口 → 触发 ResizeObserver → 再调窗口」的反馈环。
 * 4. 浮层内部的高度上限必须用固定 px 而非 vh，否则会与窗口高度互相放大成正反馈。
 * 5. 最大化 / 全屏时跳过，不与用户意图打架。
 */
export function useAutoWindowHeight(
  contentRef: ElementRef,
  overlays: OverlayTarget[] = [],
  /**
   * 暂停高度自适应。用于 tooltip 这类**瞬时浮层**：
   * 浮层出现时若把窗口撑高，位置随之漂移，鼠标可能移出触发区，
   * 触发隐藏 → 窗口缩回 → 再次进入触发区，形成闪烁死循环。
   * 因此浮层显示期间冻结窗口高度，关闭后再重新对齐。
   */
  paused = false
): void {
  // overlays 是每次渲染新建的数组，不能直接进依赖；用 ref 持有最新值，
  // 依赖里只放"是否有浮层打开"这个布尔量，保证 ref 对象本身稳定。
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const anyOverlayOpen = overlays.some((o) => o.open);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const win = getCurrentWindow();
    let lastApplied = 0;
    let frame = 0;
    let disposed = false;

    /** 取内容容器与所有已打开浮层的最大高度 */
    const measure = (): number => {
      let h = contentEl.getBoundingClientRect().height;
      for (const o of overlaysRef.current) {
        if (!o.open) continue;
        const box = o.ref.current;
        if (box) h = Math.max(h, box.getBoundingClientRect().height);
      }
      return h;
    };

    const applyHeight = async () => {
      if (disposed) return;
      // 暂停时不做任何调整，也不更新 lastApplied，
      // 这样恢复后首次测量仍会与旧值产生差值、正常触发一次对齐。
      if (pausedRef.current) return;

      const content = measure();
      if (!content || Math.abs(content - lastApplied) <= HEIGHT_EPSILON) return;

      try {
        if ((await win.isMaximized()) || (await win.isFullscreen())) return;

        const [outer, inner, scaleFactor] = await Promise.all([
          win.outerSize(),
          win.innerSize(),
          win.scaleFactor(),
        ]);
        if (disposed) return;

        // 物理像素差值换算为逻辑像素：标题栏 + 上下边框
        const chrome = (outer.height - inner.height) / scaleFactor;
        const widthLogical = inner.width / scaleFactor;

        // 用屏幕可用高度（已排除任务栏）收敛上限，防止窗口超出屏幕
        const monitor = await currentMonitor();
        if (disposed) return;

        const viewportCap = monitor
          ? (monitor.workArea.size.height / monitor.scaleFactor) * VIEWPORT_RATIO -
            chrome
          : Infinity;

        const maxContent = Math.max(
          MIN_CONTENT_HEIGHT,
          Math.min(HARD_MAX_CONTENT_HEIGHT, viewportCap)
        );
        const target = Math.min(Math.max(content, MIN_CONTENT_HEIGHT), maxContent);

        if (Math.abs(target - lastApplied) <= HEIGHT_EPSILON) return;
        lastApplied = target;

        await win.setSize(new LogicalSize(widthLogical, target + chrome));
      } catch (e) {
        // 窗口能力不可用（如缺少 set-size 权限）时静默降级，不影响页面功能
        console.warn("自适应窗口高度失败:", e);
      }
    };

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        void applyHeight();
      });
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(contentEl);
    for (const o of overlaysRef.current) {
      if (o.open && o.ref.current) observer.observe(o.ref.current);
    }
    schedule(); // 首帧对齐，从配置的固定高度切到内容高度

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // anyOverlayOpen 变化时重建 observer，以便观察新挂载的浮层；
    // paused 变化时重建，是为了在解除暂停后重新触发一次 schedule() 对齐高度
    // （暂停期间跳过的调整不会自行补偿）。
  }, [contentRef, anyOverlayOpen, paused]);
}
