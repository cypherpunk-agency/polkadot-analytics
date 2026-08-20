// `npm run dev` — Vite and the API side by side, the way production is shaped.
//
// Two processes, not one, because that is what actually ships: Vite owns the documents and
// hot-reload, the Node server owns `/api`, and `vite.config.mjs` proxies `/api` and `/healthz`
// to it. So in development, exactly as in production, **the browser only ever talks to one
// origin**. Developing against a second origin and discovering the CSP at deploy time is the
// failure this arrangement exists to prevent.
//
// No process manager, no dependency. Two `spawn` calls and a signal handler is the whole job.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TASKS = [
  { name: 'api', color: '\x1b[36m', command: process.execPath, args: ['server/index.mjs', '--dev'] },
  // `npm exec` rather than a bare `vite`: the binary lives in node_modules/.bin, which is not on
  // PATH here, and the shim name differs on Windows.
  { name: 'web', color: '\x1b[35m', command: 'npm', args: ['exec', '--', 'vite'] },
]

const RESET = '\x1b[0m'
const children = []
let shuttingDown = false

/** Prefix every line so two interleaved streams stay readable. */
function pipe(stream, label, color) {
  let carry = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    const lines = (carry + chunk).split('\n')
    carry = lines.pop() ?? ''
    for (const line of lines) process.stdout.write(`${color}${label}${RESET} ${line}\n`)
  })
  stream.on('end', () => {
    if (carry) process.stdout.write(`${color}${label}${RESET} ${carry}\n`)
  })
}

for (const task of TASKS) {
  // `shell: true` on Windows only: `npm` is a `.cmd` shim there and spawning it without a shell
  // is ENOENT. On POSIX a shell would only add a process between us and our signals.
  const child = spawn(task.command, task.args, {
    cwd: ROOT,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  pipe(child.stdout, task.name, task.color)
  pipe(child.stderr, task.name, task.color)

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    // If either half dies, stop the other. A half-running dev environment where the API is gone
    // but the site still serves is a confusing hour: the pages render and every chart is empty,
    // which is the same symptom as a CSP problem or an upstream outage.
    process.stdout.write(`${task.color}${task.name}${RESET} exited (${signal ?? code}) — stopping the other half\n`)
    stop()
    process.exitCode = code ?? 1
  })

  children.push(child)
}

function stop() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => {
    for (const child of children) child.kill('SIGKILL')
  }, 4000).unref()
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)

process.stdout.write(
  `\n  site  http://localhost:5180\n  api   http://localhost:8080/api\n\n` +
    `  /api is proxied through Vite, so the browser sees one origin — same as production.\n\n`,
)
