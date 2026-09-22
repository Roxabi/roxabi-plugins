import type * as ChildProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, expect } from 'vitest'

/**
 * Counts the processes a test file really forks, and fails a unit test that
 * forks any.
 *
 * A forking test pays for process startup plus whatever the child does, which
 * on a loaded CI runner can exceed the 5s default priced for an in-process
 * unit test (#502). Those tests belong in the `integration` project, named
 * `*.integration.test.*`, where the budget is 30s.
 *
 * The count is taken at run time rather than read off the source, because the
 * property that matters is whether the test *reaches* a fork. A test that
 * forks only through an imported helper looks clean in its own text and still
 * pays the full cost.
 */
const childProcess = createRequire(import.meta.url)('node:child_process') as typeof ChildProcess

const SPAWNERS = ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'] as const

let forks = 0

// Patching needs write access to the module's exports, which the namespace
// type does not model. The counted calls stay typed at every call site.
const patchable = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>

for (const name of SPAWNERS) {
  const original = patchable[name]
  if (typeof original !== 'function') continue
  patchable[name] = (...args: unknown[]) => {
    forks++
    return original(...args)
  }
}

/**
 * Bun global shim for Vitest (Node.js worker) environment.
 *
 * Tests that spy on Bun.spawnSync / Bun.spawn via vi.spyOn need Bun to be
 * defined — the spy wraps the shim and the mock replaces the return value,
 * so the shim implementation only matters for tests that call it directly
 * (e.g. doctor.integration.test.ts subprocess integration tests).
 *
 * It routes through `childProcess.spawnSync` rather than a captured import so
 * that a fork started here is counted like any other.
 */
if (typeof globalThis.Bun === 'undefined') {
  // biome-ignore lint/suspicious/noExplicitAny: bun-types makes the Bun global too complex to satisfy without any
  ;(globalThis as any).Bun = {
    spawnSync: (
      cmd: string[],
      opts?: {
        stdout?: string
        stderr?: string
        cwd?: string
        env?: Record<string, string>
      },
    ) => {
      const result = childProcess.spawnSync(cmd[0], cmd.slice(1), {
        cwd: opts?.cwd,
        env: opts?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        stdout: result.stdout ? new Uint8Array(result.stdout) : new Uint8Array(),
        stderr: result.stderr ? new Uint8Array(result.stderr) : new Uint8Array(),
        exitCode: result.status ?? 1,
        success: (result.status ?? 1) === 0,
      }
    },
    // Async spawn — tests that use it mock it via vi.spyOn(Bun, 'spawn')
    spawn: (..._args: unknown[]) => ({
      exited: Promise.resolve(1),
      stdout: null,
      stderr: null,
    }),
  }
}

/** Set by the measurement run that decides which files belong in `integration`. */
const report = process.env.FORK_REPORT

afterAll(() => {
  const testPath = expect.getState().testPath ?? ''
  if (report) {
    appendFileSync(report, `${forks}\t${testPath}\n`)
    return
  }
  if (forks === 0 || testPath.includes('.integration.test.')) return
  throw new Error(
    `This test forked ${forks} process(es) on the 5s unit budget, so it flakes under CI load (#502).\n` +
      `Rename it to *.integration.test.<ext> to run it in the integration project at 30s.`,
  )
})
