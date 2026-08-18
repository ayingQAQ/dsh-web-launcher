# DSH Web Launcher

由 DSH 管理的 Windows 一键启动器。它为 DeepSeek Harness Web 创建桌面快捷方式：
首次双击启动 `dsh web` 并打开浏览器，再次双击则在后台重启 DSH 并刷新现有页面，
让刚安装、卸载或修改的插件立即生效。

## 通过 DSH 安装

```powershell
dsh plugin --profile web add github:ayingQAQ/dsh-web-launcher
```

重新启动一次 DSH Web。插件加载后会自动创建或更新桌面的 **DSH Web** 快捷方式，
以后插件的安装、更新和卸载记录均由 web profile 管理。

在 DSH 的 **设置 → 通用设置 → DSH 一键启动器** 中可以检查状态、重新创建或
移除桌面快捷方式。卸载插件前若不再需要快捷方式，请先在这里将其移除。

卸载插件：

```powershell
dsh plugin --profile web remove dsh-web-launcher
```

## 独立安装

不希望把它加入 DSH profile 时，也可以继续作为普通 npm 工具使用：

```powershell
npm install -g dsh-web-launcher
dsh-web-launcher setup
```

可用命令：

```powershell
dsh-web-launcher start
dsh-web-launcher setup
dsh-web-launcher status
dsh-web-launcher remove
```

## 行为

- 默认地址为 `http://127.0.0.1:3080`，使用默认 web profile。
- 首次启动显示 DSH 自身的终端窗口，服务就绪后自动打开浏览器。
- 再次双击会确认 3080 端口属于 DSH，再在后台重启对应进程。
- 重启完成后刷新标题含“DeepSeek Harness”的现有浏览器窗口；找不到时打开新页面。
- 连续点击会合并成一次操作，避免重复停止、启动和刷新。
- 稳定运行文件位于 `%LOCALAPPDATA%\dsh-web-launcher\runtime`。
- 日志位于 `%LOCALAPPDATA%\dsh-web-launcher\logs`，最多保留当前和上一份日志。
- 快捷方式使用原生 Windows Shell Link API 创建，不调用 PowerShell。

## 限制

当前版本仅支持 Windows、默认 web profile 和默认端口 3080。DSH 删除插件时不会
主动执行第三方卸载脚本，因此应先从插件设置项移除桌面快捷方式，再卸载插件。

## 许可与归属

本项目采用 MIT License。DeepSeek Harness 图标来源与许可见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本项目是独立工具，不是 DeepSeek 官方产品。
