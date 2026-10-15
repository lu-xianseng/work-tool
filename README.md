# Work Tool（进程管理与定时任务工具）

> 一款面向 Windows 的桌面效率工具：按主程序分组管理应用进程、定时关机 / 重启，并内置 AI 对话（NEW-API 兼容），基于 Tauri 2 + React + Rust 构建。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-lightgrey.svg)](https://www.microsoft.com/windows)
[![Rust](https://img.shields.io/badge/Rust-1.85%2B-orange)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/Tauri-2.x-violet)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)

## 项目简介

Work Tool 是一个轻量级 Windows 桌面工具，提供两大核心能力：

- **进程管理**：按主程序分组展示 CPU 与内存占用，悬停查看完整进程树，支持一键复制 PID、结束整组进程、初始化清理应用持久化配置。
- **定时关机 / 重启**：支持每天 / 每周 / 每月三种周期，任务执行前弹出倒计时确认窗口，防止误关机。
- **AI 对话**：多会话聊天，支持新建 / 切换 / 删除对话、粘贴图片、代码块一键复制；基于 NEW-API（OpenAI 兼容接口）自定义模型。

仓库采用「主项目 + 子部件」结构：主项目（本目录）负责进程管理与定时任务编排，`action/` 子部件是独立的「关机 / 重启确认窗口」程序，二者各自独立构建打包。

## 功能特性

### 进程管理

- 按主程序分组展示 CPU 与内存占用（已按逻辑核心数归一化，含所有子进程）
- 悬停进程数徽标查看完整进程树（父子层级缩进展示），支持滚动与复制 PID
- 一键停止整组进程、初始化应用（清理配置中的文件 / 目录）
- 应用与清理路径可配置，返回设置页时自动保存

### 定时关机 / 重启

- 每天 / 每周 / 每月三种循环周期，精确到分钟
- 实时倒计时展示下一次任务
- 任务触发前弹出确认窗口（`action/` 子部件），可取消执行，防止误操作
- 任务清单持久化（SQLite），支持单个删除与清空全部

### AI 对话

- 多会话管理：新建 / 切换 / 删除对话（删除前二次确认），删除当前对话后自动切换
- 消息支持直接粘贴图片（≤ 4MB / 张，以 data URL 内嵌，发送时转为 OpenAI image_url 格式）
- 代码块独立渲染并支持一键复制
- 对话列表、消息记录与 AI 配置均持久化为本地 JSON（应用数据目录，Rust 侧读写）

## 技术栈

| 层级 | 主项目（work-tool） | 子部件（action） |
|------|--------------------|------------------|
| 后端 | Rust + Tauri 2 | Rust + Tauri 2 |
| 前端 | React 19 + TypeScript + Vite | React 18 + Vite 5 |
| 存储 | SQLite（rusqlite bundled）+ JSON 文件 | - |
| AI | NEW-API（OpenAI 兼容接口，reqwest 调用） | - |
| 目标平台 | Windows 10 / 11 | Windows 10 / 11 |

## 仓库结构

```
.
├── src/                  # 主项目前端（React + TS）
│   ├── pages/            #   按模块拆分：ProcessPage / TimerPage / ChatPage / AboutPage
│   ├── chat.ts           #   AI 对话的类型与 invoke 封装
│   └── useAutoWindowHeight.ts
├── src-tauri/            # 主项目后端（Rust）
│   ├── src/              #   process.rs（进程）/ timer.rs（定时任务）/ chat.rs（AI 对话）
│   └── tauri.conf.json   #   打包配置（内嵌 action.exe 资源）
├── action/               # 子部件：关机 / 重启确认窗口（独立可打包）
│   ├── src/              #   前端（React + Vite）
│   ├── src-tauri/        #   后端（Rust）
│   └── image/            #   子部件 README 截图
├── LICENSE               # Apache License 2.0
└── README.md
```

## 环境要求

- Windows 10 / 11
- [Rust](https://www.rust-lang.org/tools/install) 1.85+（主项目使用 edition 2024；子部件要求 1.77+）
- [Node.js](https://nodejs.org/) 20.19+（Vite 8 要求）
- [Tauri 2 系统依赖](https://tauri.app/start/prerequisites/)（WebView2、MSVC Build Tools）

## 快速开始

### 主项目（work-tool）

```bash
# 1. 安装前端依赖
npm install

# 2. 开发模式运行
npm run tauri dev

# 3. 仅构建前端（不含安装包）
npm run build

# 4. 构建发布安装包（NSIS）
npm run tauri build
```

### 子部件（action）

```bash
cd action

# 1. 安装依赖
npm install

# 2. 开发模式运行
npm run tauri dev

# 3. 构建发布安装包（NSIS）
npm run tauri build
```

### 打包主项目前：准备 action.exe

主项目安装包会把子部件编译出的 `action.exe` 作为资源内嵌（见 `src-tauri/tauri.conf.json` 的 `resources`）。因此**打包主项目前需先构建子部件**：

```bash
# 1. 构建子部件
cd action
npm install
npm run tauri build

# 2. 将编译产物放置到主项目的 src-tauri/ 目录
copy action\src-tauri\target\release\action.exe ..\src-tauri\action.exe

# 3. 回到主项目根目录构建安装包
cd ..
npm run tauri build
```

> 说明：`action.exe` 与 `apps.ini` 属于本地运行时产物，已被 `.gitignore` 排除，不会提交到仓库；克隆仓库后按上述步骤自行准备即可。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。

## 致谢

- 定时关机 / 重启功能集成自 [Lorien Timer](https://github.com/lu-xianseng/timer)（原 Python / PyQt5 版本的 Rust / Tauri 重写）。
- 子部件 `action/`（关机 / 重启确认窗口）独立维护于本仓库。
