import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'

test('isolated Windows cold start, authenticated restart, pinned command and stale-token refusal', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-launcher-test-'))
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const bin = join(dir, 'bin')
  await mkdir(bin)
  const shim = join(bin, 'dsh.cmd')
  await writeFile(shim, `@"${process.execPath}" "${resolve('test/fixtures/fake-dsh.js')}" %*\r\n`)
  const statePath = join(dir, 'dsh-web-launcher', 'server.json')
  let currentPid
  t.after(async () => {
    try { currentPid = Number(await readFile(join(dir, 'pid'), 'utf8')) } catch { /* server did not launch */ }
    if (currentPid) spawnSync('taskkill.exe', ['/pid', String(currentPid), '/t', '/f'], { windowsHide: true })
    // This is the unique test-owned directory; no user's runtime lives here.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const uiLog = join(dir, 'ui.jsonl')
  const env = { ...process.env, LOCALAPPDATA: dir, DSH_HOME: join(dir, 'home'), DSH_LAUNCHER_URL: `http://127.0.0.1:${port}`, TEST_UI_LOG: uiLog }
  env.TEST_PID_FILE = join(dir, 'pid')
  delete env.NODE_TEST_CONTEXT
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path')
  env[pathKey] = `${bin};${env[pathKey]}`
  async function run() {
    const code = `import {start} from ${JSON.stringify(pathToFileURL(resolve('src/index.js')).href)}; await start()`
    const child = spawn(process.execPath, ['--import', pathToFileURL(resolve('test/fixtures/no-desktop.js')).href, '--input-type=module', '-e', code], { env, windowsHide: true })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.stdout.resume()
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', status => resolve({ status, stderr })) })
  }
  const concurrent = await Promise.all([run(), run(), run()])
  for (const result of concurrent) assert.deepEqual(result, { status: 0, stderr: '' })
  const first = JSON.parse(await readFile(statePath, 'utf8'))
  currentPid = first.pid
  // where.exe expands Windows 8.3 paths (e.g. RUNNER~1 on GitHub runners).
  assert.equal((await realpath(first.command)).toLowerCase(), (await realpath(shim)).toLowerCase())
  assert.match(first.launchUrl, /\?token=.+/)
  const firstUi = (await readFile(uiLog, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(firstUi, [{ action: 'open', args: [first.launchUrl] }])
  // Remove the discovery path: restart must retain the original installation.
  env[pathKey] = env[pathKey].split(';').filter(value => value !== bin).join(';')
  assert.deepEqual(await run(), { status: 0, stderr: '' })
  const second = JSON.parse(await readFile(statePath, 'utf8'))
  currentPid = second.pid
  assert.notEqual(second.launchUrl, first.launchUrl)
  const ui = (await readFile(uiLog, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(ui.length, 2)
  assert.equal(ui[1].action, 'refresh')
  assert.equal(ui[1].args.at(-1), second.launchUrl)
  // A matching PID alone must not authorize killing an authenticated process.
  await writeFile(statePath, JSON.stringify({ ...second, launchUrl: first.launchUrl }))
  const refused = await run()
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /实例凭证已改变/)
  assert.equal((await fetch(env.DSH_LAUNCHER_URL)).status, 401)
})
