# DSH Web Launcher

Windows 上的 DeepSeek Harness Web 一键启动器。这是一个独立工具，并非 DSH
内部插件：桌面图标可以启动 `dsh web`；服务就绪后自动打开浏览器。再次双击则在
后台重启 DSH，让刚安装、卸载或修改的插件立即生效，并刷新现有页面。

## 安装

先安装 DSH：

```powershell
npm install -g @deepseek-ai/dsh
```

再安装启动器并创建桌面快捷方式：

```powershell
npm install -g dsh-web-launcher
dsh-web-launcher setup
```

之后双击桌面的 **DSH Web** 图标即可。

## 行为

- 固定启动默认 web profile，地址为 `http://127.0.0.1:3080`。
- 首次启动会显示 DSH 自身的终端窗口，服务就绪后自动打开浏览器。
- 再次双击会在后台重启占用 3080 端口且已确认属于 DSH 的进程。
- 重启完成后，启动器会尝试激活标题含“DeepSeek Harness”的浏览器窗口并按 F5；找不到时才打开新页面。
- 连续点击会合并成一次操作，避免重复停止进程、重复刷新或争抢浏览器焦点。
- `setup` 会把运行文件复制到 `%LOCALAPPDATA%\dsh-web-launcher\runtime`，因此移动或删除源码目录不会破坏桌面快捷方式。
- 启动、刷新、报错与 `setup` 均不调用 PowerShell。
- 日志保存在 `%LOCALAPPDATA%\dsh-web-launcher\logs\latest.log`；达到 1 MiB 后在下次启动时轮转为 `previous.log`。
- 启动过程不显示额外终端窗口；失败时显示中文提示窗口。

## 命令

```powershell
dsh-web-launcher start
dsh-web-launcher setup
```

`npx dsh-web-launcher start` 可用于临时启动。需要长期使用桌面图标时，请全局安装后执行 `setup`。

## 限制

当前版本仅支持 Windows、默认 web profile 和默认端口 3080，不提供端口配置。

## 许可与归属

本项目采用 MIT License。DeepSeek Harness 图标的来源与许可见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。本项目是独立工具，不是 DeepSeek 官方产品。
