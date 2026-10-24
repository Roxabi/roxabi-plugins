import { spawn } from 'node:child_process'

/** Hook vars that redirect git, stripped before any git or hook child runs. */
const GIT_REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
]

export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of GIT_REDIRECTS) delete env[key]
  return env
}

/**
 * Spawn `exe` in its own process group, no shell. The run ends when the hook
 * exits: a grandchild left holding its output does not keep it open, and on the
 * deadline the whole group is signalled, not just the direct child.
 */
export function runArgv(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; output: string; timedOut: boolean }>()
  const child = spawn(exe, args, {
    cwd,
    env: cleanEnv(),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let timedOut = false
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name)
    } catch {
      /* the group is already gone */
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    signal('SIGTERM')
    setTimeout(() => signal('SIGKILL'), 5000).unref()
  }, timeoutMs)
  let settled = false
  let grace: NodeJS.Timeout | undefined
  const groupAlive = () => {
    try {
      if (!child.pid) return false
      process.kill(-child.pid, 0)
      return true
    } catch {
      return false
    }
  }
  const settle = (code: number | null, extra = '') => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(grace)
    child.stdout?.destroy()
    child.stderr?.destroy()
    const result = { code, output: `${output}${extra}`, timedOut }
    // The hook is done: nothing it started outlives it in a checkout about to be
    // removed. SIGTERM the group, then SIGKILL whatever ignores it for 2 s.
    signal('SIGTERM')
    let waited = 0
    const reap = () => {
      if (!groupAlive()) return resolve(result)
      if (waited >= 2000) {
        signal('SIGKILL')
        return resolve(result)
      }
      waited += 50
      setTimeout(reap, 50)
    }
    reap()
  }
  child.on('error', (error) => settle(null, error.message))
  // `close` follows `exit` once the pipes drain; a grandchild holding them open
  // gets a short grace, then the pipes are dropped.
  child.on('close', (code) => settle(code))
  child.on('exit', (code) => {
    grace = setTimeout(() => settle(code), 250)
  })
  return promise
}
