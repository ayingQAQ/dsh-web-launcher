import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireStartupLock,
  browserPidFromTasklist,
  endpointProbe,
  listeningPidFromNetstat,
  makeErrorRunner,
  makeHiddenRunner,
  makeRefreshRunner,
  parseCsvLine,
  vbsString,
  waitForDsh,
} from '../src/core.js'

let server
let url

before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    if (request.url === '/other') response.end('<title>Another app</title>')
    else if (request.url === '/large') response.end(`<script>window.__DSH_BOOT__ = {}</script>${'x'.repeat(70_000)}`)
    else response.end('<script>window.__DSH_BOOT__ = {}</script>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  url = `http://127.0.0.1:${address.port}`
})

after(async () => new Promise((resolve) => server.close(resolve)))

test('escapes quoted VBScript strings', () => {
  assert.equal(vbsString('a"b'), '"a""b"')
  assert.match(makeHiddenRunner('C:\\node.exe', 'C:\\app.js'), /shell\.Run/)
  assert.match(makeRefreshRunner(), /SendKeys "\{F5\}"/)
  assert.match(makeErrorRunner(), /\.Popup/)
})

test('recognizes a DSH boot page', async () => {
  assert.equal((await endpointProbe(url)).kind, 'dsh')
  assert.equal((await endpointProbe(`${url}/large`)).kind, 'dsh')
  assert.equal((await endpointProbe(`${url}/other`)).kind, 'other')
  assert.equal((await waitForDsh(url, 500)).kind, 'dsh')
})

test('parses Windows process and socket output', () => {
  const tasklist = '"msedge.exe","7136","Console","1","100,000 K","Running","USER","0:00:01","会话 — DeepSeek Harness - Microsoft Edge"'
  assert.equal(parseCsvLine(tasklist)[4], '100,000 K')
  assert.equal(browserPidFromTasklist(tasklist), 7136)
  const netstat = '  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    4904'
  assert.equal(listeningPidFromNetstat(netstat), 4904)
})

test('serializes concurrent startup attempts with a lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launcher-'))
  const lockPath = join(directory, 'startup.lock')
  const release = await acquireStartupLock(lockPath)
  const second = await acquireStartupLock(lockPath)
  assert.equal(second.busy, true)
  await release()
  const releaseAgain = await acquireStartupLock(lockPath)
  assert.equal(typeof releaseAgain, 'function')
  await releaseAgain()
  await rm(directory, { recursive: true, force: true })
})

test('recovers a dead-owner lock without waiting 65 seconds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launcher-stale-'))
  const lockPath = join(directory, 'startup.lock')
  await writeFile(lockPath, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }))
  const release = await acquireStartupLock(lockPath, { malformedGraceMs: 0 })
  assert.equal(typeof release, 'function')
  await release()
  await rm(directory, { recursive: true, force: true })
})

test('an old owner cannot remove a replacement lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launcher-token-'))
  const lockPath = join(directory, 'startup.lock')
  const release = await acquireStartupLock(lockPath)
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'replacement' }))
  await release()
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, 'replacement')
  await rm(directory, { recursive: true, force: true })
})
