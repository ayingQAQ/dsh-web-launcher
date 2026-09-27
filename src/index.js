import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import {
  DEFAULT_URL,
  acquireStartupLock,
  browserPidFromTasklist,
  dshLaunchCommand,
  dshUrlFromOutput,
  endpointProbe,
  launcherUrl,
  listeningPidFromNetstat,
  makeErrorRunner,
  makeHiddenRunner,
  makeRefreshRunner,
  sendKeysText,
  verifyLaunchUrl,
  waitForDsh,
  writeText,
} from './core.js'

const entryPath = fileURLToPath(import.meta.url)
const require = createRequire(import.meta.url)
const packagePath = resolve(dirname(entryPath), '..', 'package.json')
const packageRoot = resolve(dirname(entryPath), '..')
const packageInfo = JSON.parse(await readFile(packagePath, 'utf8'))
const isWindows = process.platform === 'win32'
const appDir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-web-launcher')
const logDir = join(appDir, 'logs')
const logPath = join(logDir, 'latest.log')
const lockPath = join(appDir, 'startup.lock')
const statePath = join(appDir, 'server.json')
const runnerPath = join(appDir, 'launch-dsh-web.vbs')
const refreshRunnerPath = join(appDir, 'refresh-dsh-web.vbs')
const errorRunnerPath = join(appDir, 'show-error.vbs')
const obsoleteShortcutCreatorPath = join(appDir, 'create-shortcut.vbs')
const obsoleteDesktopPathRunnerPath = join(appDir, 'desktop-path.vbs')
const runtimeDir = join(appDir, 'runtime')
const installedEntryPath = join(runtimeDir, 'bin', 'dsh-web-launcher.js')
// Keep the icon filename versioned. Windows caches shortcut icons by path, so
// replacing bytes at an existing path can leave the desktop showing an old icon.
const installedIconPath = join(runtimeDir, 'assets', 'dsh-web-launcher-whale-rounded.ico')
const sourceIconPath = resolve(packageRoot, 'assets', 'dsh-web-launcher-whale-rounded.ico')
const previousLogPath = join(logDir, 'previous.log')
const MAX_LOG_BYTES = 1024 * 1024

function ensureWindows() {
  if (!isWindows) throw new Error('dsh-web-launcher v1 仅支持 Windows。')
}

function showError(title, message) {
  try {
    mkdirSync(appDir, { recursive: true })
    // Replace an older, unbounded helper even when failure occurs before setup.
    writeFileSync(errorRunnerPath, makeErrorRunner(), 'utf8')
    spawnSync('wscript.exe', ['//Nologo', errorRunnerPath, title, message], { windowsHide: true, stdio: 'ignore', timeout: 20_000 })
  } catch { /* stderr below remains the final fallback */ }
}

function openBrowser(url = DEFAULT_URL) {
  const child = spawn('explorer.exe', [url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function findDshCommand() {
  for (const candidate of ['dsh.cmd', 'dsh']) {
    const result = spawnSync('where.exe', [candidate], { encoding: 'utf8', windowsHide: true })
    if (result.status === 0) {
      const found = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      if (found) return found
    }
  }
  return null
}

function appendLog(text) {
  const fd = openSync(logPath, 'a')
  writeSync(fd, text)
  return fd
}

function writeLog(text) {
  const fd = appendLog(text)
  closeSync(fd)
}

async function rotateLogs() {
  try {
    const info = await stat(logPath)
    if (info.size < MAX_LOG_BYTES) return
    await rm(previousLogPath, { force: true })
    await rename(logPath, previousLogPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') writeLog(`\n[${new Date().toISOString()}] Log rotation skipped: ${error.message}\n`)
  }
}

function launchDsh(command, { visible, url, cwd, dshHome }) {
  const logFd = appendLog(`\n[${new Date().toISOString()}] Starting: ${command} web\n`)
  // npm installs `dsh` as a Windows .cmd shim. Let cmd.exe parse the fully
  // quoted command line once; wrapping it again as a separate /c argument
  // produces literal backslashes and the shim never starts.
  const child = spawn(dshLaunchCommand(command, url), {
    shell: true,
    detached: false,
    // Keep inherited redirection intact; unref plus file stdio still lets
    // the service outlive the short-lived launcher on Windows.
    windowsHide: !visible,
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  child.unref()
  return child
}

function browserWindowPid() {
  for (const image of ['msedge.exe', 'chrome.exe', 'firefox.exe']) {
    const result = spawnSync('tasklist.exe', ['/fi', `IMAGENAME eq ${image}`, '/v', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
    })
    if (result.status !== 0) continue
    const pid = browserPidFromTasklist(result.stdout)
    if (pid !== null) return pid
  }
  return null
}

function refreshExistingDshTab(url) {
  const pid = browserWindowPid()
  if (pid === null || !existsSync(refreshRunnerPath)) return false
  const result = spawnSync('wscript.exe', ['//B', '//Nologo', refreshRunnerPath, String(pid), sendKeysText(url)], {
    windowsHide: true,
    stdio: 'ignore',
  })
  return result.status === 0
}

function listeningPid(url) {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
  })
  if (result.status !== 0) return null
  return listeningPidFromNetstat(result.stdout, url)
}

async function writeHelperScripts() {
  await Promise.all([
    writeText(refreshRunnerPath, makeRefreshRunner()),
    writeText(errorRunnerPath, makeErrorRunner()),
  ])
}

async function stopRunningDsh(url, state) {
  const pid = listeningPid(url)
  if (pid === null) throw new Error('检测到 DSH 正在运行，但无法定位其进程。请手动关闭后重试。')
  if (state?.pid !== pid || state.baseUrl !== url) {
    throw new Error('当前 DSH 不是本版启动器记录的实例。请先手动关闭一次，再用桌面快捷方式启动；本次未停止任何进程。')
  }
  const confirmation = await endpointProbe(url)
  if (confirmation.statusCode === 401 && !(await verifyLaunchUrl(state.launchUrl))) {
    throw new Error('DSH 实例凭证已改变，已取消重启。请手动关闭后用快捷方式启动。')
  }
  const confirmedPid = listeningPid(url)
  if (confirmation.kind !== 'dsh' || confirmedPid !== pid) {
    throw new Error('DSH 进程在重启前发生变化。为避免结束错误进程，本次操作已取消。')
  }
  writeLog(`\n[${new Date().toISOString()}] Restarting DSH: stopping process tree ${pid}\n`)
  const result = spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  })
  if (result.status !== 0) {
    throw new Error(`无法停止当前 DSH 进程（PID ${pid}）：${(result.stderr || result.stdout).trim()}`)
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await endpointProbe(url)).kind === 'offline' && listeningPid(url) === null) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('当前 DSH 在 10 秒内未停止。请关闭后重试。')
}

async function launchOutput(offset) {
  const handle = await open(logPath, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
}

export async function start() {
  ensureWindows()
  const url = launcherUrl(process.env.DSH_LAUNCHER_URL || DEFAULT_URL)
  await mkdir(logDir, { recursive: true })

  const lock = await acquireStartupLock(lockPath)
  if (lock.busy) {
    // Coalesce repeated desktop clicks. The first process owns the complete
    // restart + refresh flow; followers must not wait and refresh again.
    return
  }

  try {
    await writeHelperScripts()
    let existing = await endpointProbe(url)
    if (existing.kind === 'offline' && listeningPid(url) !== null) {
      existing = await waitForDsh(url, 5_000)
      if (existing.kind !== 'dsh') {
        throw new Error(`${url} 已有程序正在启动或无响应。为避免重复启动 DSH，本次操作已取消。`)
      }
    }
    if (existing.kind === 'other') {
      throw new Error(`${url} 已被非 DSH 服务占用。请关闭占用端口的程序后再试。`)
    }
    const restarting = existing.kind === 'dsh'

    let state = null
    try { state = JSON.parse(await readFile(statePath, 'utf8')) } catch { /* first launch */ }
    const dsh = restarting ? state?.command : findDshCommand()
    if (!dsh || !existsSync(dsh)) {
      if (restarting) throw new Error('当前实例的 DSH 启动路径未知或已移除。请手动关闭后重新启动；不会自动切换到另一套 DSH。')
      throw new Error('未找到 dsh 命令。请先运行：npm install -g @deepseek-ai/dsh')
    }
    // Validate before stopping a healthy server.
    dshLaunchCommand(dsh, url)
    const cwd = restarting ? state.cwd : homedir()
    const dshHome = restarting ? state.dshHome : resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
    if (!cwd || !existsSync(cwd) || !dshHome) throw new Error('已记录的 DSH 启动环境不完整，请手动重新启动。')
    if (restarting) await stopRunningDsh(url, state)
    await rotateLogs()
    const offset = await stat(logPath).then(info => info.size, () => 0)

    let exited = null
    const child = launchDsh(dsh, { visible: !restarting, url, cwd, dshHome })
    child.once('error', (error) => { exited = error.message })
    child.once('exit', (code) => { exited = `进程已退出（代码 ${String(code)}）` })
    const deadline = Date.now() + 60_000
    let ready = { kind: 'offline' }
    while (Date.now() < deadline && exited === null) {
      ready = await endpointProbe(url)
      const launchUrl = dshUrlFromOutput(await launchOutput(offset), url)
      if (ready.kind === 'dsh' && launchUrl
        && (ready.statusCode !== 401 || await verifyLaunchUrl(launchUrl))) {
        const pid = listeningPid(url)
        if (pid === null) throw new Error('DSH 已启动，但无法记录进程。为安全起见未自动打开页面。')
        await writeText(statePath, JSON.stringify({ pid, command: dsh, baseUrl: url, launchUrl, cwd, dshHome }))
        if (restarting && refreshExistingDshTab(launchUrl)) return
        openBrowser(launchUrl)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    if (ready.kind === 'other') {
      throw new Error(`${url} 被其他服务占用。DSH 未能启动。`)
    }
    throw new Error(`未能取得 DSH 的就绪地址${exited ? `：${exited}` : '（等待 60 秒）'}。请查看日志：${logPath}；不要公开其中的 token。`)
  } finally {
    // Keep the lock briefly after the browser refresh so a burst of desktop
    // clicks cannot immediately start a second restart cycle.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await lock()
  }
}

function expandEnvironmentVariables(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key === undefined ? match : process.env[key]
  })
}

function desktopPath() {
  const result = spawnSync('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '/v',
    'Desktop',
  ], { encoding: 'utf8', windowsHide: true, timeout: 3_000 })
  if (result.status !== 0) throw new Error(`无法读取桌面目录：${(result.stderr || result.stdout).trim()}`)
  const match = /^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(result.stdout)
  if (match === null) throw new Error('Windows 注册表中没有 Desktop 路径。')
  return expandEnvironmentVariables(match[1])
}

function shortcutPath() {
  return join(desktopPath(), 'DSH Web.lnk')
}

function shortcutTargetPath() {
  return join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')
}

function shortcutArguments() {
  return `//B //Nologo "${runnerPath}"`
}

function sameWindowsPath(left, right) {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
}

function shortcutIsCurrent() {
  try {
    const shortcut = require('windows-shortcut-napi')
    const info = shortcut.query(shortcutPath())
    return sameWindowsPath(info.target, shortcutTargetPath())
      && info.args === shortcutArguments()
      && sameWindowsPath(info.workingDir, appDir)
      && sameWindowsPath(info.icon, installedIconPath)
  } catch {
    return false
  }
}

function createShortcut() {
  const shortcut = require('windows-shortcut-napi')
  const path = shortcutPath()
  shortcut.create(path, {
    target: shortcutTargetPath(),
    args: shortcutArguments(),
    workingDir: appDir,
    runStyle: shortcut.SW_SHOWMINNOACTIVE,
    icon: installedIconPath,
    iconIndex: 0,
    desc: '启动 DeepSeek Harness Web',
  })
  return path
}

async function copyIfDifferent(source, destination) {
  if (resolve(source).toLowerCase() === resolve(destination).toLowerCase()) return
  await copyFile(source, destination)
}

async function installStableRuntime() {
  await mkdir(join(runtimeDir, 'bin'), { recursive: true })
  await mkdir(join(runtimeDir, 'src'), { recursive: true })
  await mkdir(join(runtimeDir, 'assets'), { recursive: true })
  await Promise.all([
    copyIfDifferent(resolve(packageRoot, 'bin', 'dsh-web-launcher.js'), installedEntryPath),
    copyIfDifferent(entryPath, join(runtimeDir, 'src', 'index.js')),
    copyIfDifferent(resolve(packageRoot, 'src', 'core.js'), join(runtimeDir, 'src', 'core.js')),
    copyIfDifferent(packagePath, join(runtimeDir, 'package.json')),
    copyIfDifferent(sourceIconPath, installedIconPath),
  ])
}

export async function desktopStatus() {
  ensureWindows()
  let version = null
  try {
    version = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8')).version ?? null
  } catch { /* runtime is not installed yet */ }
  return {
    shortcut: shortcutIsCurrent(),
    runtime: existsSync(installedEntryPath) && existsSync(installedIconPath),
    version,
  }
}

export async function setup({ quiet = false } = {}) {
  ensureWindows()
  await mkdir(appDir, { recursive: true })
  if (!existsSync(sourceIconPath)) throw new Error(`缺少图标资源：${sourceIconPath}`)
  await writeHelperScripts()
  await installStableRuntime()
  await writeText(runnerPath, makeHiddenRunner(process.execPath, installedEntryPath))
  const shortcutPath = createShortcut()
  await Promise.all([
    rm(obsoleteShortcutCreatorPath, { force: true }),
    rm(obsoleteDesktopPathRunnerPath, { force: true }),
  ])
  if (!quiet) process.stdout.write(`已创建桌面快捷方式：${shortcutPath}\n`)
  return desktopStatus()
}

export async function removeDesktopSetup() {
  ensureWindows()
  await Promise.all([
    rm(shortcutPath(), { force: true }),
    rm(runtimeDir, { recursive: true, force: true }),
    rm(runnerPath, { force: true }),
    rm(refreshRunnerPath, { force: true }),
    rm(errorRunnerPath, { force: true }),
    rm(obsoleteShortcutCreatorPath, { force: true }),
    rm(obsoleteDesktopPathRunnerPath, { force: true }),
    rm(lockPath, { force: true }),
    rm(statePath, { force: true }),
  ])
  return desktopStatus()
}

function printHelp() {
  process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n\n用法:\n  dsh-web-launcher start\n  dsh-web-launcher setup\n  dsh-web-launcher status\n  dsh-web-launcher remove\n`)
}

export async function runCli() {
  const command = process.argv[2] || 'start'
  if (command === 'start') await start()
  else if (command === 'setup') await setup()
  else if (command === 'status') process.stdout.write(`${JSON.stringify(await desktopStatus())}\n`)
  else if (command === 'remove') await removeDesktopSetup()
  else if (command === '--help' || command === '-h') printHelp()
  else throw new Error(`未知命令：${command}`)
}

export function reportCliError(error) {
  const message = error instanceof Error ? error.message : String(error)
  showError('DSH Web 启动失败', message)
  process.stderr.write(`dsh-web-launcher: ${message}\n`)
  process.exitCode = 1
}
