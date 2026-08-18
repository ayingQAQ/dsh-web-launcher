import { closeSync, existsSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import {
  DEFAULT_URL,
  acquireStartupLock,
  browserPidFromTasklist,
  endpointProbe,
  listeningPidFromNetstat,
  makeErrorRunner,
  makeHiddenRunner,
  makeRefreshRunner,
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
const runnerPath = join(appDir, 'launch-dsh-web.vbs')
const refreshRunnerPath = join(appDir, 'refresh-dsh-web.vbs')
const errorRunnerPath = join(appDir, 'show-error.vbs')
const obsoleteShortcutCreatorPath = join(appDir, 'create-shortcut.vbs')
const obsoleteDesktopPathRunnerPath = join(appDir, 'desktop-path.vbs')
const runtimeDir = join(appDir, 'runtime')
const installedEntryPath = join(runtimeDir, 'bin', 'dsh-web-launcher.js')
// Keep the icon filename versioned. Windows caches shortcut icons by path, so
// replacing bytes at an existing path can leave the desktop showing an old icon.
const installedIconPath = join(runtimeDir, 'assets', 'dsh-web-launcher-whale.ico')
const sourceIconPath = resolve(packageRoot, 'assets', 'dsh-web-launcher-whale.ico')
const previousLogPath = join(logDir, 'previous.log')
const MAX_LOG_BYTES = 1024 * 1024

function ensureWindows() {
  if (!isWindows) throw new Error('dsh-web-launcher v1 仅支持 Windows。')
}

function showError(title, message) {
  try {
    mkdirSync(appDir, { recursive: true })
    if (!existsSync(errorRunnerPath)) writeFileSync(errorRunnerPath, makeErrorRunner(), 'utf8')
    spawnSync('wscript.exe', ['//Nologo', errorRunnerPath, title, message], { windowsHide: true, stdio: 'ignore' })
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

function dshRestartUrl() {
  return `${DEFAULT_URL}/?dsh-restart=${Date.now()}`
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

function launchDsh(command, { visible }) {
  const logFd = appendLog(`\n[${new Date().toISOString()}] Starting: ${command} web\n`)
  // npm installs `dsh` as a Windows .cmd shim. Let cmd.exe parse the fully
  // quoted command line once; wrapping it again as a separate /c argument
  // produces literal backslashes and the shim never starts.
  const child = spawn(`"${command}" web`, {
    shell: true,
    detached: true,
    // The first launch intentionally keeps DSH's own terminal visible. A
    // restart is background-only so it never covers the browser window.
    windowsHide: !visible,
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

function refreshExistingDshTab() {
  const pid = browserWindowPid()
  if (pid === null || !existsSync(refreshRunnerPath)) return false
  const result = spawnSync('wscript.exe', ['//B', '//Nologo', refreshRunnerPath, String(pid)], {
    windowsHide: true,
    stdio: 'ignore',
  })
  return result.status === 0
}

function listeningPid() {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3_000,
  })
  if (result.status !== 0) return null
  return listeningPidFromNetstat(result.stdout)
}

async function writeHelperScripts() {
  await Promise.all([
    writeText(refreshRunnerPath, makeRefreshRunner()),
    writeText(errorRunnerPath, makeErrorRunner()),
  ])
}

async function stopRunningDsh() {
  const pid = listeningPid()
  if (pid === null) throw new Error('检测到 DSH 正在运行，但无法定位其进程。请手动关闭后重试。')
  const confirmation = await endpointProbe()
  const confirmedPid = listeningPid()
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
    if ((await endpointProbe()).kind === 'offline') return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('当前 DSH 在 10 秒内未停止。请关闭后重试。')
}

export async function start() {
  ensureWindows()
  await mkdir(logDir, { recursive: true })

  const lock = await acquireStartupLock(lockPath)
  if (lock.busy) {
    // Coalesce repeated desktop clicks. The first process owns the complete
    // restart + refresh flow; followers must not wait and refresh again.
    return
  }

  try {
    await writeHelperScripts()
    let existing = await endpointProbe()
    if (existing.kind === 'offline' && listeningPid() !== null) {
      existing = await waitForDsh(DEFAULT_URL, 5_000)
      if (existing.kind !== 'dsh') {
        throw new Error('3080 端口已有程序正在启动或无响应。为避免重复启动 DSH，本次操作已取消。')
      }
    }
    if (existing.kind === 'other') {
      throw new Error(`${DEFAULT_URL} 已被非 DSH 服务占用。请关闭占用 3080 端口的程序后再试。`)
    }
    const restarting = existing.kind === 'dsh'

    const dsh = findDshCommand()
    if (dsh === null) {
      throw new Error('未找到 dsh 命令。请先运行：npm install -g @deepseek-ai/dsh')
    }
    if (restarting) await stopRunningDsh()
    await rotateLogs()

    let exited = null
    const child = launchDsh(dsh, { visible: !restarting })
    child.once('error', (error) => { exited = error.message })
    child.once('exit', (code) => { exited = `进程已退出（代码 ${String(code)}）` })
    const ready = await waitForDsh(DEFAULT_URL, 30_000)
    if (ready.kind === 'dsh') {
      if (restarting && refreshExistingDshTab()) return
      openBrowser(restarting ? dshRestartUrl() : DEFAULT_URL)
      return
    }
    if (ready.kind === 'other') {
      throw new Error(`${DEFAULT_URL} 被其他服务占用。DSH 未能启动。`)
    }
    throw new Error(`DSH 在 30 秒内未能启动${exited ? `：${exited}` : ''}。请查看日志：${logPath}`)
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
  ])
  return desktopStatus()
}

function printHelp() {
  process.stdout.write(`${packageInfo.name} ${packageInfo.version}\n\n用法:\n  dsh-web-launcher start\n  dsh-web-launcher setup\n  dsh-web-launcher remove\n`)
}

export async function runCli() {
  const command = process.argv[2] || 'start'
  if (command === 'start') await start()
  else if (command === 'setup') await setup()
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
