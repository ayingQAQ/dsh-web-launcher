import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import * as core from '../src/core.js'
import { apply } from '../src/plugin.js'

async function serve(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

test('authenticated DSH is detected without confusing a generic 401 with DSH', async t => {
  const url = await serve(t, (req, res) => {
    res.writeHead(401)
    res.end(req.url === '/' ? 'dsh web authentication required; reopen the URL printed by dsh web.\n' : 'unauthorized')
  })
  assert.equal((await core.endpointProbe(url)).kind, 'dsh')
  assert.equal((await core.endpointProbe(`${url}/other`)).kind, 'other')
})

test('legacy HTML is still detected and unrelated HTML is not', async t => {
  const url = await serve(t, (req, res) => res.end(req.url === '/' ? '<script>window.__DSH_BOOT__={}</script>' : 'hello'))
  assert.equal((await core.endpointProbe(url)).kind, 'dsh')
  assert.equal((await core.endpointProbe(`${url}/other`)).kind, 'other')
})

test('startup URL parser preserves the token and rejects foreign or incomplete announcements', () => {
  assert.equal(core.dshUrlFromOutput('dsh web: http://127.0.0.1:3080/?token=abc\n', core.DEFAULT_URL), 'http://127.0.0.1:3080/?token=abc')
  assert.equal(core.dshUrlFromOutput('dsh web: http://127.0.0.1:3080/?token=ab', core.DEFAULT_URL), null)
  assert.equal(core.dshUrlFromOutput('dsh web: http://evil.test/?token=abc\n', core.DEFAULT_URL), null)
  assert.equal(core.dshUrlFromOutput('dsh web: http://127.0.0.1:3080/\n', core.DEFAULT_URL), 'http://127.0.0.1:3080/')
})

test('launch command suppresses automatic browser opening and pins host and port', () => {
  assert.equal(core.dshLaunchCommand('C:\\Program Files\\dsh.cmd', 'http://127.0.0.1:4080'), '"C:\\Program Files\\dsh.cmd" web --no-open --host 127.0.0.1 --port 4080')
  assert.throws(() => core.dshLaunchCommand('C:\\bad%PATH%\\dsh.cmd', core.DEFAULT_URL))
  assert.throws(() => core.dshLaunchCommand('dsh.cmd', 'http://evil.test:3080'))
})

test('listener matching follows configured port, including wildcard listeners', () => {
  const output = ' TCP 0.0.0.0:4080 0.0.0.0:0 LISTENING 42\n TCP 127.0.0.1:3080 0.0.0.0:0 LISTENING 99'
  assert.equal(core.listeningPidFromNetstat(output, 'http://127.0.0.1:4080'), 42)
  assert.equal(core.listeningPidFromNetstat(output), 99)
})

test('token exchange verifies a process token rather than trusting arbitrary redirects', async t => {
  const url = await serve(t, (req, res) => {
    res.writeHead(303, { location: req.url.includes('good') ? './' : 'https://evil.test/', 'set-cookie': 'session=test; HttpOnly' })
    res.end()
  })
  assert.equal(await core.verifyLaunchUrl(`${url}/?token=good`), true)
  assert.equal(await core.verifyLaunchUrl(`${url}/?token=bad`), false)
})

test('address validation and keyboard escaping reject unsafe targets and preserve literal URLs', () => {
  for (const url of ['https://127.0.0.1:3080', 'http://127.0.0.1:3080/path', 'http://127.0.0.1:3080/?token=abc', 'http://user:pass@127.0.0.1:3080']) {
    assert.throws(() => core.launcherUrl(url))
  }
  assert.equal(core.sendKeysText('http://127.0.0.1:3080/?token=a+b%20c'), 'http://127.0.0.1:3080/?token=a{+}b{%}20c')
})

test('management fails closed for missing admission API, remote clients and cross-origin writes', async () => {
  for (const scenario of [
    { connection: {}, remote: '127.0.0.1', origin: 'http://127.0.0.1:3080', want: 503 },
    { connection: { admit: () => ({ peer: {} }) }, remote: '192.168.1.2', origin: 'http://127.0.0.1:3080', want: 403 },
    { connection: { admit: () => ({ peer: {} }) }, remote: '127.0.0.1', origin: 'http://evil.test', want: 403 },
  ]) {
    const routes = []
    const host = { connection: scenario.connection, webServer: { register(route) { routes.push(route); return () => {} } }, effect(fn) { fn() } }
    apply({ inject(names, fn) { fn(host) } }, { autoSetup: false })
    const response = { writeHead(status) { this.status = status }, end() {} }
    await routes.find(route => route.path.endsWith('remove')).handler({ method: 'POST', headers: { host: '127.0.0.1:3080', origin: scenario.origin }, socket: { remoteAddress: scenario.remote } }, response)
    assert.equal(response.status, scenario.want)
  }
})

test('management routes reject unauthorized clients even with a same-origin header', async () => {
  const routes = []
  const host = {
    webServer: { register(route) { routes.push(route); return () => {} } },
    connection: { admit: () => ({ rejection: 401 }) },
    effect(fn) { fn() },
  }
  apply({ inject(names, fn) { fn(host) } }, { autoSetup: false })
  for (const route of routes) {
    const response = { writeHead(code) { this.status = code }, end() {} }
    await route.handler({ method: route.path.endsWith('status') ? 'GET' : 'POST', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, response)
    assert.equal(response.status, 401, route.path)
  }
  assert.equal(routes.length, 3)
})
