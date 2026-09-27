import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.TEST_PID_FILE, String(process.pid))
const args = process.argv.slice(2)
if (!args.includes('--no-open')) throw new Error('automatic browser open was not disabled')
const port = Number(args[args.indexOf('--port') + 1])
const token = randomUUID()
createServer((req, res) => {
  if (req.url === `/?token=${token}`) {
    res.writeHead(303, { location: './', 'set-cookie': 'dsh=test; HttpOnly' })
    res.end()
  } else {
    res.writeHead(401)
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`dsh web: http://127.0.0.1:${port}/?token=${token}`)
})
