/**
 * 关于页：应用简介、核心功能与注意事项（纯静态，无可配置内容）。
 */
export function AboutPage() {
  return (
    <>
      <div className="settings-header">
        <h2>关于</h2>
      </div>
      <div className="card about-card">
        {/* 应用标识：图标 + 名称 + 一句话简介 */}
        <div className="about-head"></div>

        {/* 核心功能 */}
        <section className="about-section">
          <h3 className="about-section-title">功能说明</h3>
          <ul className="about-list">
            <li>
              <strong>进程管理</strong>
              <br />
              <span>
                - 按主程序分组展示 CPU 与内存占用，悬停可查看完整进程树（含所有子进程），支持一键复制 PID 与结束整组进程。
              </span>
              <br />
              <span>
                - 支持添加监控进程，与配置文件路径，点击初始化将清理持久性配置，以实现程序恢复默认状态
              </span>
            </li>
            <li>
              <strong>定时关机 / 重启</strong>
              <br />
              <span>支持每天、每周、每月三种周期，配置执行时刻与目标动作</span>
              <br />
              <span>实时倒计时并在触发前弹出二次确认窗口，防止误操作。</span>
            </li>
            <li>
              <strong>AI 对话</strong>
              <br />
              <span>
                - 对接 NEW-API 服务，支持配置多个模型，对话内随时切换，每条对话记忆自己使用的模型。
              </span>
              <br />
              <span>
                - 对话支持新建 / 切换 / 删除。
              </span>
              <br />
              <span>
                - 支持直接粘贴图片，或上传文本类附件（含 KiCad / Eagle 等 EDA 文本格式，如 .kicad_pcb、.sch、.brd、.net）。
              </span>
              <br />
            </li>
          </ul>
        </section>

        {/* 使用说明 / 注意事项 */}
        <section className="about-section">
          <h3 className="about-section-title">注意事项</h3>
          <p className="about-text">
            定时任务执行时会强制关闭正在运行的程序并立即关机或重启，请务必提前保存好重要文件。
            结束进程会同时终止其全部子进程，操作不可撤销。
          </p>
        </section>

        {/* 底部辅助信息：字号最小、颜色最浅 */}
        <footer className="about-footer">
          项目地址：
          <a
            href="https://github.com/lu-xianseng/work-tool"
            target="_blank"
            rel="noopener noreferrer"
          >
            https://github.com/lu-xianseng/work-tool
          </a>
        </footer>
      </div>
    </>
  );
}
