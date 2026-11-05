import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { lineageFixture } from './cause-lineage-fixture.ts'

it('validates a sixteen-transition authenticated collection in a bounded real consumer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cause-lineage-'))
  try {
    const path = process.env.OMP_CAUSE_LINEAGE_FIXTURE ?? join(directory, 'fixture.json')
    if (!process.env.OMP_CAUSE_LINEAGE_FIXTURE) writeFileSync(path, JSON.stringify(lineageFixture(16, false)))
    const child = spawnSync('bun', [fileURLToPath(new URL('./cause-lineage-consumer.ts', import.meta.url)), path], {
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('authenticated-lineage-ok\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
