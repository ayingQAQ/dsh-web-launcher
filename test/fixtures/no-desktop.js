// Isolate Windows UI side effects in the integration-test launcher process.
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
const spawn = childProcess.spawn
const spawnSync = childProcess.spawnSync
childProcess.spawn = (command, args, options) => {
  if (command !== 'explorer.exe') return spawn(command, args, options)
  appendFileSync(process.env.TEST_UI_LOG, JSON.stringify({ action: 'open', args }) + '\n')
  return Object.assign(new EventEmitter(), { unref() {} })
}
childProcess.spawnSync = (command, args, options) => {
  if (command === 'tasklist.exe') return { status: 0, stdout: '"msedge.exe","123","Console","1","0 K","Running","test","0:00:00","DeepSeek Harness"' }
  if (command === 'wscript.exe') {
    appendFileSync(process.env.TEST_UI_LOG, JSON.stringify({ action: 'refresh', args }) + '\n')
    return { status: 0 }
  }
  return spawnSync(command, args, options)
}
syncBuiltinESMExports()
