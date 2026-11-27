<div align="center">

# 码道 Switch · CodeArts Switch

**面向华为云 CodeArts（码道）的多智能体可视化切换控制台与 Tauri v2 独立窗口桌面客户端**

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Tauri v2](https://img.shields.io/badge/Desktop-Tauri%20v2-24C8D8?logo=tauri&logoColor=white)](./src-tauri)
[![Go 1.24](https://img.shields.io/badge/Gateway-Go%201.24-00ADD8?logo=go&logoColor=white)](./gateway)
[![React 19](https://img.shields.io/badge/Console-React%2019%20%2B%20Tailwind-61DAFB?logo=react&logoColor=black)](./src)
[![Windows Cloud Build](https://img.shields.io/badge/CI-GitHub%20Actions%20Auto%20Release-2088FF?logo=githubactions&logoColor=white)](./.github/workflows/release.yml)

</div>

---

## 二开声明与致谢

> 本项目基于开源项目 **[`2951461586/CodeArts2API`](https://github.com/2951461586/CodeArts2API)**（Apache License 2.0）进行深度二次开发与桌面端整合，完整保留了上游仓库的开源协议与核心能力，并在此向原作者致谢。

| 模块维度 | 上游 `CodeArts2API` 原有核心（完整保留） | 本项目 `码道 Switch` 二次开发新增与源码改造 |
| :--- | :--- | :--- |
| **华为云底层鉴权与网关** | SDK-HMAC-SHA256 SigV4 签名、CodeArts IDE 凭据解密、浏览器 PKCE + DPoP OAuth 登录、多账号池自动续期、积分余额查询、`/v1/chat/completions` 与 `/v1/messages` | 新增 **Codex OpenAI Responses API (`/v1/responses`)** 桥接与 `/v1/messages/count_tokens` 估算端点；支持 Codex 桌面端未识别模型自动回落到自选 CodeArts 模型（与 Claude Code / DSH 隔离，无需全局强制模型） |
| **上游协议与流式源码修复** | `gateway/internal/protocol/anthropic.go` 与 `gateway/internal/server/anthropic.go` 基础协议转换 | 修改上游转换源码：修复混合 `tool_result` + 文本块时消息顺序颠倒导致的 `HTTP 400`；新增 `SanitizeOpenAIMessages` 自动补齐中断/重试遗留的缺失 `tool_call_id` 回应并清理孤立 `role=tool`；修复流式 SSE 连续多工具块切换与无参工具调用的 `stop_reason` 判定 |
| **前端控制台** | 单页轻量管理页 | 全新中文化 **React + Tailwind 现代化多页签控制台**（智能体切换、账号与积分、模型目录、日志与密钥、网关设置），支持自定义 `model_aliases` 可视化编辑与 GitHub Releases 内置版本更新检测 |
| **多智能体零冲突切换** | 需手动配置各客户端环境变量 | 内置 **Claude Code / Codex CLI & 桌面软件 / DeepSeek Harness (`dsh`)** 双模式切换，配置持久化到 `switch-profiles.json`，与 **CC Switch 零冲突** 且 100% 共享 `/resume` 会话历史 |
| **桌面客户端形态** | 命令行终端运行 | **Tauri v2 独立窗口桌面客户端** + 无黑框 Go Sidecar + 系统托盘常驻 + GitHub Actions 云端自动打包发布 |

> **源码修改说明（Apache-2.0 第 4(b) 条）**：除新增 `gateway/internal/switcher/`、`gateway/internal/server/responses.go`、`gateway/internal/server/switch_routes.go` 等模块外，本项目也对上游 `gateway/main.go`、`gateway/internal/server/server.go`、`gateway/internal/server/anthropic.go` 与 `gateway/internal/protocol/anthropic.go` 进行了版本注入、协议加固与流式工具块修复（并附带单元测试），完整变更历史可在仓库 Git Commit 记录中查阅。

---

## 核心特性

### 1. 与 CC Switch 零冲突 & 100% 双向共享会话历史
- **模式 A · 零侵入接力（推荐 CLI 用户）**
  - 不改写 `~/.claude/settings.json` 与 `~/.codex/config.toml`，原生支持 Windows **CMD / PowerShell** 与 **Bash / Zsh**。
  - **Claude Code**：写入独立隔离覆盖文件 `~/.codearts-switch/claude-override.json`（`0600`），通过 `claude --settings ... --model ...` 高优先级注入，彻底避免被 CC Switch 既有配置覆盖，同时完整共享 `/resume` 历史与 MCP。
- **模式 B · 全局无损合并（支持一键快照还原）**
  - 精准合并路由字段，完整保留你原有的 `hooks`、`permissions`、`mcp_servers`、`projects` 与 `OPENAI_API_KEY`；写入前自动留存 SHA-256 快照，随时一键回滚。
- **Codex 桌面软件 / VS Code 插件双方案支持**
  - 模式 B 默认采用 `requires_openai_auth = false` + `http_headers` 免环境变量直连格式，重开 Codex 桌面软件即可直接使用。
  - 内置 **Codex 未识别模型自动回落**（默认开启）：当 Codex 桌面端下发内置模型标识（如 `gpt-6.2-sol`、`gpt-5.6-sol`）时，仅在 `/v1/responses` 自动路由至你在 Codex 卡片选定的 CodeArts 模型，无需开启全局 `force_model`，不干扰 Claude Code 与 DeepSeek Harness；也可在网关设置中配置自定义 `model_aliases`。
  - 页面内置 **「配合 CC Switch 使用」一键复制卡片**（含 `Base URL`、可显示/复制的 `API Key`、模型名与完整 `TOML` 片段），可直接添加进 CC Switch → Codex 随时切换。

### 2. Claude Code / Codex 严格工具调用协议加固
- 自动将同一条 `user` 消息内的 `tool_result` 排在文本 / `<system-reminder>` 之前，满足 Kimi（`kimi-k3.1-pro`）等严格校验 OpenAI 协议的上游要求。
- 自动修复因用户中断、上游 `502` 或历史截断遗留的未配对 `tool_calls` 与孤立 `role=tool` 消息，避免后续轮次连续报 `HTTP 400`。
- 修复 OpenAI SSE → Anthropic SSE 流式转发时连续多个 `tool_use` 块未正确关闭/开启、以及无参工具调用 `stop_reason` 误判的问题。

### 3. Tauri v2 独立窗口桌面客户端与无缝更新
- **开箱即用，无黑框**：双击桌面图标自动在后台拉起内置无窗口 Go 网关核心（`127.0.0.1:10087`），`/health` 就绪后原窗口同源直连加载控制台（零 CORS 问题）。
- **系统托盘常驻**：点击右上角关闭按钮自动最小化到右下角系统托盘，保持后台网关持续服务；右键托盘可随时唤出窗口、在浏览器打开或彻底退出并优雅关闭后台进程。
- **内置更新检查 & 数据保留**：启动时自动检查 GitHub Releases 新版本并在顶部与设置页提示；下载新版 `setup.exe` 直接覆盖安装即可，账号、密钥、切换配置与快照保存在 `%APPDATA%\com.codearts.switch\`，升级不会丢失。

---

## 下载与安装（推荐：直接从 GitHub Releases 下载）

无需在本地安装 Rust 或 Go 编译环境：

1. 点击本仓库右侧 **Releases** 页面，下载最新版本的 Windows 安装包：
   - **`CodeArts-Switch_*_x64-setup.exe`**（推荐：Tauri 独立窗口桌面客户端安装包，升级时直接覆盖安装即可保留全部数据）
   - **`CodeArts-Switch_*_x64_en-US.msi`**（Windows MSI 安装包）
   - **`codearts-switch-gateway-windows-amd64.exe`**（纯 Go 轻量单文件控制台版，无桌面窗口）
2. 双击 `setup.exe` 完成安装，打开桌面图标后前往 **「账号与积分」→「浏览器 OAuth」** 一键拉起系统浏览器登录华为云即可开始使用。

### 如何触发 GitHub 云端自动打包

本仓库已内置 [`.github/workflows/release.yml`](./.github/workflows/release.yml)，支持两种触发方式（打包前会自动运行 `go test -v ./internal/protocol/...` 协议单测）：

- **方式一（最简单，网页点一下即可）**：进入你的 GitHub 仓库 → **Actions** → 选中 **Build & Release Windows Desktop App** → 点击 **Run workflow**（默认发布 `v1.0.2` 到 Releases），等待约 3–5 分钟即可在 **Releases** 页面直接下载 `.exe` 安装包。
- **方式二（打 Git 标签自动发布）**：
  ```bash
  git tag v1.0.2
  git push origin v1.0.2
  ```

---

## 仓库目录结构

```text
.
├── gateway/               # 基于 2951461586/CodeArts2API 二开的 Go 网关核心（含 /v1/responses、Switch API 与协议加固）
├── src/                   # React 19 + TypeScript + Tailwind v4 中文可视化控制台
├── src-tauri/             # Tauri v2 Rust 原生独立窗口外壳、系统托盘与 Sidecar 守护进程
├── scripts/               # Windows / 跨平台本地一键构建脚本
├── .github/workflows/     # GitHub Actions 云端自动构建与 Release 发布流水线
├── server.ts              # 开发预览用 Node.js 服务（支持热桥接本地 Go 网关）
└── LICENSE                # Apache License 2.0
```

---

## 版本更新记录

- **`v1.0.2`**：修复 Claude Code 使用 Kimi 等严格校验模型时的 `HTTP 400 (tool_call_ids did not have response messages)`；修复混合 `tool_result` + 文本块顺序、自动补齐中断遗留工具回应、修复流式连续多 `tool_use` 块切换，并为 `/v1/responses` 同步接入消息序列校验与 Go 协议单测。
- **`v1.0.1`**：新增 Codex 桌面端未识别模型自动回落（无需开启全局强制模型）与 `switch-profiles.json` 持久化；新增 `model_aliases` 可视化编辑与 GitHub Releases 版本更新检查；修复日志/密钥 Unix 秒时间戳显示为 `1970` 与 `login_port = 0` 无法保存的问题。
- **`v1.0.0`**：首个 Tauri v2 + Go Sidecar 独立窗口桌面版，支持 Claude Code / Codex / DeepSeek Harness 双模式零冲突切换与 GitHub Actions 云端自动打包。

---

## 本地开发与手动打包（可选）

仅在需要本地二次开发或调试时使用：

```powershell
# 1. 启动前端与本地预览服务
npm install
npm run dev

# 2. 仅使用 Go 编译单文件网关（无需 Rust）
npm run build:gateway

# 3. 本地打包 Tauri v2 独立窗口安装包（需 Node 20+ / Go 1.24+ / Rust）
npm run build:desktop
```

---

## 开源协议

本项目遵循 **[Apache License 2.0](./LICENSE)** 开源协议，与上游项目 [`2951461586/CodeArts2API`](https://github.com/2951461586/CodeArts2API) 保持一致。
