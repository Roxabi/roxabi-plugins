// Temporary Q904 hosted diagnostic; remove after capture.
const { spawn } = require('node:child_process')
const { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, statSync } = require('node:fs')
const { tmpdir, availableParallelism, constants } = require('node:os')
const path = require('node:path')

const limit = 2 * 1024 * 1024
const dir = mkdtempSync(path.join(tmpdir(), 'q904-ci-'))
const output = path.join(dir, 'events.jsonl')
const emit = (record) => {
  try {
    const line = `${JSON.stringify(record)}\n`
    if (line.length <= 8192 && !existsAtLimit()) appendFileSync(output, line)
  } catch {}
}
function existsAtLimit() {
  try { return statSync(output).size >= limit } catch { return false }
}
const read = (file) => {
  try { return readFileSync(file, 'utf8').trim() } catch { return null }
}
const numbers = (text) => text?.match(/^\d+(?:[-, ]\d+)*$/)?.[0] ?? null
const groupNumbers = (name) => {
  const text = groupRead(name)
  return text && /^(?:[a-z_.]+ \d+\n?)+$/.test(text) ? text.slice(0, 2048) : null
}
const cgroupPath = read('/proc/self/cgroup')?.split('\n').find((line) => line.startsWith('0::'))?.slice(3)
const cgroup = cgroupPath ? path.join('/sys/fs/cgroup', cgroupPath) : null
const groupRead = (name) => cgroup ? read(path.join(cgroup, name)) : null
const cpuMax = groupRead('cpu.max')
emit({ kind: 'capacity', time: Date.now(), availableParallelism: availableParallelism(), maxWorkers: Math.min(8, Math.max(1, availableParallelism() - 1)), affinity: numbers(read('/proc/self/status')?.split('\n').find((line) => line.startsWith('Cpus_allowed_list:'))?.split(':')[1]?.trim()), cpuMax: cpuMax && /^(?:max|\d+) \d+$/.test(cpuMax) ? cpuMax : null, cpuStat: groupNumbers('cpu.stat'), memoryMax: numbers(groupRead('memory.max')), memoryCurrent: numbers(groupRead('memory.current')) })
const child = spawn('bun', ['run', 'test'], { stdio: 'inherit', env: { ...process.env, Q904_CI_DIAGNOSTIC: output } })
let samples = 0
const sample = () => {
  if (samples++ >= 720) return
  emit({ kind: 'resource', time: Date.now(), cpuStat: groupNumbers('cpu.stat'), memoryCurrent: numbers(groupRead('memory.current')), memoryPeak: numbers(groupRead('memory.peak')) })
  const processes = []
  try {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const stat = read(`/proc/${name}/stat`)
      const match = stat?.match(/^\d+ \((.*)\) (\S+) (\d+) (.*)$/)
      if (!match) continue
      const fields = match[4].split(' ')
      const comm = ['bun', 'node', 'git', 'gh', 'vitest'].includes(match[1]) ? match[1] : 'other'
      // fields starts at /proc/<pid>/stat field 5; rss is field 24.
      processes.push({ pid: Number(name), ppid: Number(match[3]), comm, userTicks: Number(fields[9]), systemTicks: Number(fields[10]), rssPages: Number(fields[19]) })
    }
  } catch {}
  const descendants = new Set([child.pid])
  for (let pass = 0; pass < 20; pass++) {
    const count = descendants.size
    for (const item of processes) if (descendants.has(item.ppid)) descendants.add(item.pid)
    if (count === descendants.size) break
  }
  emit({ kind: 'process-sample', time: Date.now(), processes: processes.filter((item) => descendants.has(item.pid)).slice(0, 50) })
}
const timer = setInterval(sample, 1000)
sample()
child.on('error', () => { clearInterval(timer); console.error('Q904 diagnostic: unable to launch test'); process.exitCode = 1 })
child.on('close', (code, signal) => {
  clearInterval(timer)
  sample()
  console.log('Q904 diagnostic events begin')
  try {
    const fd = openSync(output, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      const length = readSync(fd, buffer, 0, limit, 0)
      const text = buffer.toString('utf8', 0, length)
      process.stdout.write(text.slice(0, text.lastIndexOf('\n') + 1))
    } finally { closeSync(fd) }
  } catch {}
  console.log('Q904 diagnostic events end')
  process.exitCode = code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1)
})
