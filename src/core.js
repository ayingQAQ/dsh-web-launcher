import { randomUUID } from 'node:crypto'
import { open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'

export const DEFAULT_URL = 'http://127.0.0.1:3080'
export const DSH_MARKER = '__DSH_BOOT__'
const AUTH_REQUIRED = 'dsh web authentication required; reopen the URL printed by dsh web.'

export function launcherUrl(value = DEFAULT_URL) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('启动器地址必须是 http://127.0.0.1:<端口>')
  return url.origin
}

export function dshLaunchCommand(command, baseUrl) {
  const url = new URL(launcherUrl(baseUrl))
  // cmd.exe expands percent variables even inside quotes. Never interpolate
  // a path containing shell expansion/control characters.
  if (/["%\r\n!]/.test(command)) throw new Error('DSH 命令路径包含不支持的字符')
  return `"${command}" web --no-open --host 127.0.0.1 --port ${url.port || '80'}`
}

export function dshUrlFromOutput(output, baseUrl) {
  const expected = launcherUrl(baseUrl)
  let found = null
  for (const line of output.split(/\r?\n/).slice(0, -1)) {
    const match = /^dsh web: (http:\/\/\S+)(?:\s|$)/.exec(line)
    if (!match) continue
    try {
      const url = new URL(match[1])
      if (url.origin === expected && url.pathname === '/' && !url.username && !url.password && !url.hash) found = url.href
    } catch { /* ignore malformed announcements */ }
  }
  return found
}

// Only exchange a local launch token. Do not follow redirects or send cookies;
// this proves the token still belongs to the running process before a restart.
export function verifyLaunchUrl(value, timeoutMs = 1500) {
  const url = new URL(value)
  launcherUrl(url.origin)
  if (!url.searchParams.has('token')) return Promise.resolve(false)
  return new Promise(resolve => {
    const timer = setTimeout(() => { req.destroy(); resolve(false) }, timeoutMs)
    const req = request(url, res => {
      clearTimeout(timer)
      res.resume()
      resolve(res.statusCode === 303 && res.headers.location === './' && Boolean(res.headers['set-cookie']?.length))
    })
    req.on('error', () => { clearTimeout(timer); resolve(false) })
    req.end()
  })
}

export function sendKeysText(value) {
  return value.replace(/[+^%~(){}\[\]]/g, char => `{${char}}`)
}

/** Escape a value for a quoted VBScript string literal. */
export function vbsString(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

export function makeHiddenRunner(nodePath, entryPath) {
  const command = `${vbsString(nodePath)} ${vbsString(entryPath)} start`
  return [
    "Option Explicit",
    "Dim shell",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run ${vbsString(command)}, 0, False`,
  ].join('\r\n') + '\r\n'
}

export function makeRefreshRunner() {
  return [
    'Option Explicit',
    'If WScript.Arguments.Count <> 2 Then WScript.Quit 1',
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    'If shell.AppActivate(CLng(WScript.Arguments(0))) Then',
    '  WScript.Sleep 150',
    '  If Not shell.AppActivate(CLng(WScript.Arguments(0))) Then WScript.Quit 2',
    '  shell.SendKeys "^l"',
    '  WScript.Sleep 100',
    '  shell.SendKeys WScript.Arguments(1)',
    '  shell.SendKeys "{ENTER}"',
    '  WScript.Quit 0',
    'End If',
    'WScript.Quit 2',
  ].join('\r\n') + '\r\n'
}

export function makeErrorRunner() {
  return [
    'Option Explicit',
    'If WScript.Arguments.Count <> 2 Then WScript.Quit 1',
    'CreateObject("WScript.Shell").Popup WScript.Arguments(1), 0, WScript.Arguments(0), 16',
  ].join('\r\n') + '\r\n'
}

export function parseCsvLine(line) {
  const fields = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else quoted = !quoted
    } else if (char === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else value += char
  }
  fields.push(value)
  return fields
}

export function browserPidFromTasklist(output) {
  for (const line of output.split(/\r?\n/)) {
    const fields = parseCsvLine(line)
    const image = fields[0]?.toLowerCase()
    const pid = Number.parseInt(fields[1], 10)
    const title = fields[8] ?? ''
    if (['msedge.exe', 'chrome.exe', 'firefox.exe'].includes(image)
      && title.includes('DeepSeek Harness') && Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return null
}

export function listeningPidFromNetstat(output, baseUrl = DEFAULT_URL) {
  const port = new URL(launcherUrl(baseUrl)).port || '80'
  const addresses = new Set([`127.0.0.1:${port}`, `0.0.0.0:${port}`, `[::]:${port}`])
  for (const line of output.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns.length >= 5 && addresses.has(columns[1]) && columns[3] === 'LISTENING') {
      const pid = Number.parseInt(columns[4], 10)
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null
    }
  }
  return null
}

export function endpointProbe(url = DEFAULT_URL, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(result)
    }
    const req = request(url, { method: 'GET', timeout: timeoutMs }, (response) => {
      let body = ''
      const statusCode = response.statusCode ?? null
      const classify = () => ({
        kind: ((statusCode === 200 && body.includes(DSH_MARKER))
          || (statusCode === 401 && body.trim() === AUTH_REQUIRED))
          ? 'dsh'
          : 'other',
        statusCode,
      })
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body = (body + chunk).slice(0, 64 * 1024)
        if (body.includes(DSH_MARKER) || body.length === 64 * 1024) {
          response.destroy()
          finish(classify())
        }
      })
      response.on('end', () => finish(classify()))
      response.on('error', () => finish({ kind: 'offline', statusCode: null }))
    })
    // `request`'s timeout is an inactivity timeout. Keep an absolute deadline
    // too, so a non-DSH service that streams forever cannot stall a launch.
    timer = setTimeout(() => {
      req.destroy()
      finish({ kind: 'offline', statusCode: null })
    }, timeoutMs)
    req.on('timeout', () => req.destroy())
    req.on('error', () => finish({ kind: 'offline', statusCode: null }))
    req.end()
  })
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForDsh(url, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs
  let last = { kind: 'offline', statusCode: null }
  while (Date.now() < deadline) {
    last = await endpointProbe(url)
    if (last.kind === 'dsh') return last
    await delay(intervalMs)
  }
  return last
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function acquireStartupLock(lockPath, options = {}) {
  const malformedGraceMs = options.malformedGraceMs ?? 5_000
  const maximumAgeMs = options.maximumAgeMs ?? 10 * 60_000
  const token = randomUUID()
  try {
    const handle = await open(lockPath, 'wx')
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }))
    } catch (error) {
      await handle.close().catch(() => {})
      await rm(lockPath, { force: true }).catch(() => {})
      throw error
    }
    await handle.close()
    return async () => {
      try {
        const current = JSON.parse(await readFile(lockPath, 'utf8'))
        if (current?.token === token) await rm(lockPath, { force: true })
      } catch { /* already removed or replaced */ }
    }
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    try {
      const info = await stat(lockPath)
      const ageMs = Date.now() - info.mtimeMs
      let owner = null
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch { /* partially written */ }
      const ownerAlive = processIsAlive(owner?.pid)
      if ((!ownerAlive && ageMs >= malformedGraceMs) || ageMs >= maximumAgeMs) {
        await rm(lockPath, { force: true })
        return acquireStartupLock(lockPath, options)
      }
      return { busy: true, ownerPid: owner?.pid ?? null }
    } catch {
      return { busy: true, details: '' }
    }
  }
}

export async function writeText(path, text) {
  await writeFile(path, text, 'utf8')
}
