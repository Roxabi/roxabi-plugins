import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { expect, it } from 'vitest'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = path.resolve(import.meta.dirname, '../testing/fix-recovery-close-pause-worker.ts')

it.each(['before-entry', 'during-confirmation'] as const)(
  'holds an eligible neutral close when an authenticated pause arrives %s',
  (timing) => {
    const run = spawnSync(bun, [worker, timing], { encoding: 'utf8', timeout: 170_000 })
    expect(run.status, `${run.error ?? ''}\n${run.stderr}\n${run.stdout}`).toBe(0)
  },
  180_000,
)
