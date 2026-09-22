import type * as ChildProcess from 'node:child_process'
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

/**
 * Wraps a spawn entry point so the call is counted, keeping every own property
 * of the original.
 *
 * `util.promisify` dispatches on the `promisify.custom` symbol, which is how
 * `promisify(exec)` resolves to `{ stdout, stderr }` instead of the bare first
 * callback argument. A wrapper that drops it would quietly change the shape of
 * a live consumer's result (see promote/lib/hotfix-density.ts).
 */
function counted<T extends object>(original: T): T {
  const wrapper = function (this: unknown, ...args: unknown[]) {
    forks++
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  }
  Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original))
  return wrapper as unknown as T
}

// Patching needs write access to the module's exports, which the namespace
// type does not model. The counted calls stay typed at every call site.
const patchable = childProcess as unknown as Record<string, object>

for (const name of SPAWNERS) {
  const original = patchable[name]
  if (typeof original !== 'function') continue
  patchable[name] = counted(original)
}

/**
 * Bun global shim for Vitest (Node.js worker) environment.
 *
 * Tests that spy on Bun.spawnSync / Bun.spawn via vi.spyOn need Bun to be
 * defined — the spy wraps the shim and the mock replaces the return value,
 * so the shim implementation only matters for tests that call it directly
 * (e.g. doctor.integration.test.ts subprocess integration tests).
 *
 * It routes through `childProcess.spawnSync`, already counted above, so a fork
 * started here is counted exactly once.
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
} else {
  // Under a real Bun runtime the shim is absent, and Bun.spawn* reaches the OS
  // without passing through node:child_process. Count it directly.
  const bun = globalThis.Bun as unknown as Record<string, object>
  for (const name of ['spawn', 'spawnSync'] as const) {
    if (typeof bun[name] === 'function') bun[name] = counted(bun[name])
  }
}

/**
 * Matches the `integration` project's include glob. A looser `includes()` check
 * would exempt a file the glob does not actually route there, such as
 * `x.integration.test.helpers.test.ts`.
 */
const INTEGRATION_FILE = /\.integration\.test\.(?:c|m)?[jt]sx?$/

afterAll(() => {
  if (forks === 0) return
  const testPath = expect.getState().testPath ?? ''
  if (INTEGRATION_FILE.test(testPath)) return
  throw new Error(
    `This test forked ${forks} process(es) on the 5s unit budget, so it flakes under CI load (#502).\n` +
      `Rename it to *.integration.test.<ext> to run it in the integration project at 30s.`,
  )
})
