import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  it('the emitted workflow passes actionlint (only queue-staleness suppressed)', () => {
    if (!hasActionlint()) {
      // CI installs actionlint (ci.yml, before the vitest step). Its absence
      // UNDER CI means this schema-validity gate silently regressed to a no-op —
      // the exact presence≠validity blind spot it exists to catch (#371 B5; the
      // gate was `it.runIf(hasActionlint())` and skipped in CI). Fail loud there;
      // locally actionlint is an optional dev tool, so soft-skip.
      if (process.env.CI) {
        throw new Error(
          'actionlint not found under CI — the auto-release schema-validity gate is not running. ' +
            'Install actionlint in .github/workflows/ci.yml before the vitest step.',
        )
      }
      return
    }
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

/**
 * release.model + release.component as declared in the repo's own .claude/stack.yml.
 * The byte gate below derives the expected COMPONENT from HERE — the same source
 * /checkup N11 (workflow-drift.ts) reads — rather than a hardcoded literal, so a
 * rename of release.component that is NOT propagated into the committed
 * auto-release.yml (or a workflow whose baked COMPONENT drifts from stack.yml)
 * fails in CI, not only at /checkup runtime (#374 FU-4). Minimal regex, no YAML
 * dep: the release block is 2-space-indented children, one `component:` repo-wide.
 */
function stackRelease(): { model: string; component: string } {
  const src = readFileSync('.claude/stack.yml', 'utf8')
  const block = src.match(/^release:[^\n]*\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? ''
  return {
    model: block.match(/^\s+model:\s*([^\s#]+)/m)?.[1] ?? 'staging-train',
    component: block.match(/^\s+component:\s*([^\s#]+)/m)?.[1] ?? '',
  }
}

describe('committed auto-release.yml is byte-equal to the generator (dogfood fidelity, #371 B5)', () => {
  it('the checked-in workflow matches the generator for .claude/stack.yml release.component (#374 FU-4)', () => {
    // The CI analogue of /checkup N11 (which only runs at human runtime): a
    // generator edit not mirrored into the committed workflow — or a hand-edit
    // of the committed workflow, or a stack.yml component rename that skipped
    // regeneration — fails HERE, in CI, instead of drifting silently until the
    // first real release. Expected opts are derived from stack.yml, not hardcoded,
    // so the baked COMPONENT and the declared release.component can never diverge.
    const { model, component } = stackRelease()
    // This repo is the trunk dogfood; if model ever flips, auto-release.yml should
    // be REMOVED, not left stale — so assert the precondition rather than skip.
    expect(model).toBe('trunk')
    expect(component).not.toBe('')

    const committed = readFileSync('.github/workflows/auto-release.yml', 'utf8')
    expect(committed).toBe(generateAutoReleaseYml({ ...trunkOpts, release: { model: 'trunk', component } }))
  })
})
