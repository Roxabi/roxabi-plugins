import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateAutoReleaseYml } from '../workflows/workflow-generators'

// Schema-validity gate for the EMITTED auto-release workflow (#371 S2-T11).
//
// Presence in a generator unit test is NOT validity — dev-core's own history has
// shipped generator output that unit tests passed but a real runner rejected
// (two nonexistent action SHAs). actionlint is the authoritative GitHub Actions
// schema linter; this gate runs it over the generated YAML when it is installed.
//
// One documented false-positive is suppressed via `-ignore`, exactly and only:
// actionlint 1.7.12 does not yet recognise the `queue` concurrency key. That key
// IS valid GitHub Actions syntax — the official docs list `queue` (single | max)
// alongside `group` and `cancel-in-progress`
// (docs.github.com/actions/.../control-workflow-concurrency). The linter's schema
// is simply behind. The suppression is an exact message match, so every OTHER
// schema error in the emitted workflow still fails this gate.
const QUEUE_STALENESS = 'unexpected key "queue" for "concurrency" section'

const trunkOpts = {
  stack: 'bun',
  test: 'vitest',
  deploy: 'none',
  release: { model: 'trunk', component: 'roxabi-plugins' },
} as const

function hasActionlint(): boolean {
  const r = spawnSync('actionlint', ['-version'], { encoding: 'utf8' })
  return r.status === 0
}

const tmps: string[] = []
afterAll(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

describe('generateAutoReleaseYml — actionlint schema validity (#371 S2-T11)', () => {
  it.runIf(hasActionlint())('the emitted workflow passes actionlint (only queue-staleness suppressed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'auto-release-actionlint-'))
    tmps.push(dir)
    const wfDir = join(dir, '.github', 'workflows')
    mkdirSync(wfDir, { recursive: true })
    const wf = join(wfDir, 'auto-release.yml')
    writeFileSync(wf, generateAutoReleaseYml(trunkOpts))

    const r = spawnSync('actionlint', ['-no-color', '-ignore', QUEUE_STALENESS, wf], { encoding: 'utf8' })
    expect(r.status, `actionlint reported errors:\n${r.stdout}${r.stderr}`).toBe(0)
  })

  it('always-on structural sanity (baseline when actionlint is absent — no YAML dep)', () => {
    const yml = generateAutoReleaseYml(trunkOpts)
    for (const key of ['name:', 'on:', 'permissions:', 'concurrency:', 'jobs:']) {
      expect(yml).toContain(key)
    }
  })
})
