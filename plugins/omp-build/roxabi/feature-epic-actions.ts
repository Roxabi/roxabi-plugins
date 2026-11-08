import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runEpicPostMergeHook(cwd: string, epic: number): Promise<void> {
  const driver = fileURLToPath(new URL('../skills/feature/epic-driver.ts', import.meta.url))
  if (!existsSync(driver)) throw new Error('epic-driver-unavailable')
  const directory = mkdtempSync(join(tmpdir(), 'omp-build-epic-hook-'))
  try {
    await execFileAsync(
      'bun',
      ['--no-env-file', '--no-install', driver, 'hook', '--epic', String(epic), '--repo', cwd],
      {
        cwd: directory,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    )
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // The hook failure remains authoritative; cleanup cannot mask it.
    }
  }
}
