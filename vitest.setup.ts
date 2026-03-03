import { spawnSync as nodeSpawnSync } from 'node:child_process'

/**
 * Bun global shim for Vitest (Node.js worker) environment.
 *
 * Tests that spy on Bun.spawnSync / Bun.spawn via vi.spyOn need Bun to be
 * defined — the spy wraps the shim and the mock replaces the return value,
 * so the shim implementation only matters for tests that call it directly
 * (e.g. doctor.test.ts subprocess integration tests).
 */
if (typeof globalThis.Bun === 'undefined') {
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
      const result = nodeSpawnSync(cmd[0], cmd.slice(1), {
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
