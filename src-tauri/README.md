# 码道 Switch — Tauri v2 独立窗口桌面客户端

本目录包含 **码道 Switch** 的 Tauri v2 原生外壳，将仓库内置的 `gateway/`（基于 Apache-2.0 `CodeArts2API` 整合）以 **Sidecar 子进程** 打包进单一 Windows 桌面客户端。

## 核心架构特性

- **零 CORS / 原生同源**：启动后拉起内置 `codearts-gateway`（默认 `127.0.0.1:10087`），`/health` 就绪后将独立窗口直接导航至 `http://127.0.0.1:10087/`，天然同源复用 Go 网关鉴权。
- **AppData 可写数据目录**：自动将状态文件与切换快照定向到 `%APPDATA%\com.codearts.switch\`，安装到 `Program Files` 也不会遇到写入权限错误。
- **系统托盘与关闭最小化**：点击关闭按钮自动隐藏至右下角系统托盘，保持后台网关持续服务；右键托盘可显示窗口、在浏览器中打开或彻底退出并优雅关闭网关进程。

## Windows 一键构建（PowerShell）

前置依赖：Node.js 20+、Go 1.24+、Rust 工具链（[rustup.rs](https://rustup.rs/)）。

在项目根目录直接运行：

```powershell
.\scripts\build-tauri-windows.ps1
```

产物位于：
- NSIS 安装包：`src-tauri\target\release\bundle\nsis\`
- MSI 安装包：`src-tauri\target\release\bundle\msi\`
