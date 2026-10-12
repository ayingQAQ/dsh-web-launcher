import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

test('page reloads once when backend identity changes and retries across downtime', async () => {
  let plugin, poll, instanceId = 'old', offline = false, reloads = 0
  const disposers = []
  const window = {
    __ModuleLoader__: { load(definition) { plugin = definition.factory(() => ({ createElement() {} })) } },
    location: { reload() { reloads++ } },
    setInterval(fn) { poll = fn; return 1 },
    clearInterval() {},
  }
  runInNewContext(await readFile(new URL('../client/client.js', import.meta.url), 'utf8'), {
    window,
    fetch: async () => {
      if (offline) throw new Error('offline')
      return { ok: true, text: async () => JSON.stringify({ ok: true, status: { instanceId } }) }
    },
  })
  plugin.apply({
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    locale: { register() {} }, slots: { inject() {} },
  })
  await new Promise(resolve => setImmediate(resolve))
  await poll()
  assert.equal(reloads, 0)
  offline = true
  await poll()
  assert.equal(reloads, 0)
  offline = false
  instanceId = 'new'
  await poll()
  await poll()
  assert.equal(reloads, 1)
  disposers.forEach(dispose => dispose())
})
