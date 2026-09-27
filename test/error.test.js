import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

test('error reporting updates stale helpers and bounds both popup and process wait', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-error-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const app = join(dir, 'dsh-web-launcher')
  await mkdir(app)
  const runner = join(app, 'show-error.vbs')
  await writeFile(runner, 'stale helper')
  const log = join(dir, 'ui.jsonl')
  const env = { ...process.env, LOCALAPPDATA: dir, TEST_UI_LOG: log }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('test/fixtures/no-desktop.js')).href, resolve('bin/dsh-web-launcher.js'), 'invalid-command'], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /invalid-command/)
  const call = JSON.parse((await readFile(log, 'utf8')).trim())
  assert.equal(call.timeout, 20000)
  // Execute the generated VBScript against a fake COM shell, not a real popup.
  // Changing its Popup timeout changes the observed result below.
  const script = (await readFile(runner, 'utf8')).replaceAll('CreateObject(', 'TestCreateObject(') + `
Function TestCreateObject(name)
  Set TestCreateObject = New FakeShell
End Function
Class FakeShell
  Public Sub Popup(message, seconds, title, flags)
    WScript.Echo seconds
  End Sub
End Class
`
  const isolated = join(dir, 'check-popup.vbs')
  await writeFile(isolated, script)
  const checked = spawnSync('cscript.exe', ['//Nologo', isolated, 'title', 'message'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
  assert.equal(checked.status, 0, checked.stdout + checked.stderr)
  assert.equal(checked.stdout.trim(), '15')
})
