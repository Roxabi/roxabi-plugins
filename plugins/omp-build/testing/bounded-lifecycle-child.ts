import { spawn } from 'node:child_process'
import type { TestContext } from 'vitest'
import { probeData, probeScope } from './diagnostic-probe.ts'

// Leave time for failure reporting and the fixture's afterEach removal.
const CLEANUP_MARGIN_MS = 3_000

/** Run the lifecycle child within this test's actual remaining Vitest budget. */
export function boundedLifecycleChild(
  task: TestContext['task'],
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const started = task.result?.startTime
  if (!started || !Number.isFinite(task.timeout) || task.timeout <= 0) {
    throw new Error('lifecycle child requires a finite running test budget')
  }
  const elapsed = Date.now() - started
  const remaining = task.timeout - elapsed - CLEANUP_MARGIN_MS
  const diagnostic =
    process.env.OMP_906_RUNTIME_DIAGNOSTIC === '1' &&
    (args[1] === 'omp-review-apply-falsify' || args[1] === 'omp-review-mixed-dispositions')
  const scope = probeScope(env.GH_SIM_STATE)
  const originalRemaining = 60_000 - elapsed - CLEANUP_MARGIN_MS
  if (diagnostic)
    probeData(scope, `lifecycle:${args[1]}:child-spawn`, {
      taskStartMs: started,
      taskTimeoutMs: task.timeout,
      actualRemainingMs: remaining,
      originalRemainingMs: originalRemaining,
    })
  if (remaining <= 0) throw new Error('lifecycle child has no test budget remaining')
  if (process.platform === 'win32') throw new Error('lifecycle child requires POSIX process groups')

  const { promise, resolve, reject } = Promise.withResolvers<{
    status: number | null
    stdout: string
    stderr: string
  }>()
  const child = spawn(executable, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outputBytes = 0
  let failure: string | undefined
  let fallback: NodeJS.Timeout | undefined
  const failureError = () =>
    new Error(`${failure}\n${Buffer.concat(stderr).toString('utf8')}\n${Buffer.concat(stdout).toString('utf8')}`)
  const stop = (reason: string) => {
    if (failure) return
    failure = reason
    clearTimeout(timer)
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        child.stdout.destroy()
        child.stderr.destroy()
        reject(error)
        return
      }
    }
    // An escaped descendant can retain a pipe; do not wait indefinitely for it.
    fallback = setTimeout(() => {
      child.stdout.destroy()
      child.stderr.destroy()
      reject(failureError())
    }, 500)
  }
  if (diagnostic) probeData(scope, `lifecycle:${args[1]}:timer-arm`, { originalRemainingMs: originalRemaining })
  const timer = setTimeout(() => stop('lifecycle child exceeded remaining test budget'), remaining)
  // Do not exceed spawnSync's default 1 MiB maxBuffer, even across both pipes.
  child.stdout.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length
    if (outputBytes > 1024 * 1024) stop('lifecycle child output exceeded maxBuffer')
    else stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    outputBytes += chunk.length
    if (outputBytes > 1024 * 1024) stop('lifecycle child output exceeded maxBuffer')
    else stderr.push(chunk)
  })
  child.on('error', (error) => {
    clearTimeout(timer)
    clearTimeout(fallback)
    reject(error)
  })
  child.on('close', (status) => {
    if (diagnostic) probeData(scope, `lifecycle:${args[1]}:child-close`, { status })
    clearTimeout(timer)
    clearTimeout(fallback)
    if (failure) reject(failureError())
    else
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
  })
  return promise
}
