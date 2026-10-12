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
- 再次双击会核对本次启动记录的进程、地址和新版 DSH 的启动令牌，再在后台重启。
- 使用 `--no-open` 避免 DSH 重启时自己再弹出浏览器；就绪地址仅从本次启动输出读取。
- 重启后由已打开的 DSH 页面检测后端变化并直接刷新当前地址，保留会话路由；找不到 DSH 窗口时才打开鉴权入口。
- 重启沿用原 DSH 命令路径、工作目录和 `DSH_HOME`，不会因为 PATH 顺序变化切换安装来源。
- 连续点击会合并成一次操作，避免重复停止、启动和刷新。
- 稳定运行文件位于 `%LOCALAPPDATA%\dsh-web-launcher\runtime`。
- 日志位于 `%LOCALAPPDATA%\dsh-web-launcher\logs`，最多保留当前和上一份日志。
- 快捷方式使用原生 Windows Shell Link API 创建，不调用 PowerShell。

## 限制

当前版本仅支持 Windows 和默认 web profile，绑定本机回环地址，默认端口 3080。
如需不同端口，可在启动器进程的环境中设置 `DSH_LAUNCHER_URL=http://127.0.0.1:4080`。
PowerShell 中临时设置的环境变量只影响该窗口启动的 CLI；桌面快捷方式不会自动继承。
DSH 删除插件时不会
主动执行第三方卸载脚本，因此应先从插件设置项移除桌面快捷方式，再卸载插件。

### 0.2.5 兼容性修复

- 适配新版 DSH 首页鉴权，不再把正常的 `401` 误报为其他程序占用端口。
- 首次进入和重启都使用 DSH 提供的鉴权地址，不绕过或关闭 DSH 鉴权。
- 从旧版启动器升级后，或 DSH 原本由其他方式启动时，需要先手动关闭一次 DSH，再双击快捷方式。启动器不会自动接管未知实例。
- 插件管理接口仅接受本机请求，并复用 DSH `connection.admit()` 鉴权。旧版 DSH（如 `0.1.1-rc.2`）缺少此接口时，设置页管理会返回明确提示；请使用 `dsh-web-launcher setup/status/remove`，插件内也可通过 `node <插件目录>/bin/dsh-web-launcher.js <命令>` 调用。
- `logs` 和 `server.json` 可能包含本机启动令牌，反馈问题前请先删除 URL 中的 `token`，不要公开这些文件。
- 需要保留 DSH 的启动地址输出（`printUrl: true`，默认开启）；关闭后启动器无法取得安全入口，会超时提示而不会绕过鉴权。

已针对 `0.1.7-rc.2` 发布包核对协议，并以隔离服务测试启动、重启和鉴权流程；
不是对所有未来 DSH 版本或浏览器组合的兼容保证。运行 `npm test` 可执行回归测试，
Windows 集成测试使用临时目录和随机端口，不启动真实 DSH，也不操作桌面浏览器。
GitHub Actions 在 Windows 上对 Node.js 20、22、24 执行这些回归测试。

### 0.2.6 错误提示修复（issue #2）

- 报错弹窗在 15 秒后自动关闭，启动器对弹窗进程最多等待 20 秒，避免无人点击时长期残留。
- 即使错误发生在初始化之前，也会替换旧版无超时的弹窗脚本；完整错误仍输出到 stderr。
- 补充鉴权文本与状态码组合、关闭端口和弹窗超时测试，并修正 Windows 短路径引起的 CI 测试误报。

### 0.2.7 浏览器打开修复

- 从 Windows 默认浏览器配置读取程序路径，直接打开本次 DSH 鉴权地址；浏览器独立运行，启动器退出后保持打开。
- 配置无法解析时使用 Windows URL 打开器，并捕获浏览器进程启动错误。
- 已在本机 DSH `0.2.0-rc.2` 与 Microsoft Edge 上验证启动、重启和页面打开；设置页操作及 `0.2.1-alpha.2` 尚未实机验证。

### 0.2.8 页面刷新修复

- 移除输入鉴权网址并按回车的模拟按键脚本。
- 网页检测后端实例变化后调用 `window.location.reload()`，直接刷新当前页。
- 更新后需刷新已有页面一次以加载检测逻辑；此后重启恢复后的检测间隔为两秒。

## 许可与归属

本项目采用 MIT License。DeepSeek Harness 图标来源与许可见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本项目是独立工具，不是 DeepSeek 官方产品。
