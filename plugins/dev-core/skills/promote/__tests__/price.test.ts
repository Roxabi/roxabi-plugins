import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The sole deriver under test (S2). It does not exist yet → this suite is RED
// until price.sh lands. Resolved relative to this file so it survives the
// worktree being merged/removed (never a hardcoded worktree path).
const PRICE_SH = fileURLToPath(new URL('../price.sh', import.meta.url))

// ─── Deterministic synthetic-git-fixture harness ───────────────────────────────
//
// Every case builds a THROWAWAY git repo in the OS temp dir that reproduces a
// TOPOLOGY (no real cross-repo SHAs). Author/committer dates are fixed and
// monotonic so the DAG — not commit order — is what price.sh reads (D3: the
// priced quantity is a set difference, no date, no order).

const createdRepos: string[] = []
afterAll(() => {
  for (const dir of createdRepos) rmSync(dir, { recursive: true, force: true })
})

let clock = 0
function gitEnv(): NodeJS.ProcessEnv {
  clock += 1
  const stamp = `@${1735689600 + clock} +0000` // 2025-01-01T00:00:00Z + clock seconds
  return {
    ...process.env,
    // Isolate from the operator's global/system git config (signing, hooks, aliases).
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.com',
    GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp,
  }
}

function git(repo: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed (${r.status}): ${r.stderr}`)
  return (r.stdout ?? '').trim()
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'price-fixture-'))
  createdRepos.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

/** Empty commit (topology is all that matters) → returns its SHA. */
function commit(repo: string, subject: string, body?: string): string {
  const args = ['commit', '--allow-empty', '-m', subject]
  if (body) args.push('-m', body)
  git(repo, args)
  return git(repo, ['rev-parse', 'HEAD'])
}

function tag(repo: string, name: string, ref = 'HEAD'): void {
  git(repo, ['tag', name, ref])
}

/** Independent set-difference verification, not going through price.sh. */
function revListNoMerges(repo: string, range: string): string[] {
  const out = git(repo, ['rev-list', '--no-merges', range])
  return out ? out.split('\n').filter(Boolean) : []
}

interface PriceResult {
  stdout: string
  stderr: string
  code: number
}
function price(repo: string, args: string[]): PriceResult {
  const r = spawnSync('bash', [PRICE_SH, ...args], { cwd: repo, encoding: 'utf8' })
  return { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', code: r.status ?? -1 }
}

// ─── Case 1 — #140 topology (D3): one feat after a tag → minor ─────────────────

describe('price.sh — #140 topology (D3)', () => {
  it('prices exactly the single feat commit after the tag → minor 0.8.0', () => {
    const repo = initRepo()
    commit(repo, 'chore: init') // c0 — the released base
    tag(repo, 'comp/v0.7.0')
    const feat = commit(repo, 'feat: x') // the one commit after the tag

    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('0.8.0')

    // The priced payload (floored at the tag) is exactly that 1 commit.
    const payload = revListNoMerges(repo, 'comp/v0.7.0..main')
    expect(payload).toEqual([feat])
  })
})

// ─── Case 2 — #267→#270 hotfix-floor (D3): floor at BASE_SHA, not M^1 ───────────

describe('price.sh — #267→#270 hotfix-floor (D3)', () => {
  it('prices the direct-to-main hotfix once (BASE_SHA floor includes it; M^1 floor excludes it)', () => {
    const repo = initRepo()
    const c0 = commit(repo, 'chore: base') // BASE — what was last released
    tag(repo, 'comp/v0.21.2')

    // PR #267: a fix hotfix merged directly to main as a 2-parent merge M_h,
    // built so M_h's first parent IS the hotfix commit.
    git(repo, ['checkout', '-q', '-b', 'hotfix'])
    const hotfix = commit(repo, 'fix: zk idle-timer overflow') // H, parent c0
    git(repo, ['checkout', '-q', '-b', 'sidecar', c0])
    commit(repo, 'chore: sidecar') // S, parent c0
    git(repo, ['checkout', '-q', 'hotfix'])
    git(repo, ['merge', '--no-ff', '-m', 'merge #267 hotfix', 'sidecar']) // M_h = [H, S]
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '--ff-only', 'hotfix']) // main fast-forwards to M_h

    // PR #270: a real promote whose first parent M^1 is the hotfix merge M_h.
    git(repo, ['checkout', '-q', '-b', 'feature', c0])
    commit(repo, 'feat: new thing')
    commit(repo, 'feat: another thing')
    git(repo, ['checkout', '-q', 'main'])
    git(repo, ['merge', '--no-ff', '-m', 'chore: promote (comp/v0.22.0)', 'feature']) // M = [M_h, feature]

    const M = git(repo, ['rev-parse', 'main'])
    const M1 = git(repo, ['rev-parse', 'main^1']) // = M_h

    // Topology sanity: M_h^1 is the hotfix commit itself.
    expect(git(repo, ['rev-parse', `${M1}^1`])).toBe(hotfix)

    // price floors at the tag (BASE_SHA), so the hotfix is inside the payload → a real bump.
    const { code, stdout } = price(repo, ['comp', M1, M])
    expect(code).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/)
    expect(stdout).not.toBe('0.21.2') // non-empty payload → derived != BASE

    // Proof the BASE_SHA floor includes the hotfix EXACTLY ONCE …
    const basePayload = revListNoMerges(repo, `${c0}..${M}`)
    expect(basePayload).toContain(hotfix)
    expect(basePayload.filter((s) => s === hotfix)).toHaveLength(1)

    // … while an M^1 floor would EXCLUDE it — proving the tag floor is load-bearing.
    const m1Payload = revListNoMerges(repo, `${M1}..${M}`)
    expect(m1Payload).not.toContain(hotfix)
  })
})

// ─── Case 3 — bump map totality (D18) ──────────────────────────────────────────

/** Base tagged comp/v1.0.0, then the given payload commits after it. */
function bumpFixture(payload: Array<{ subject: string; body?: string }>): string {
  const repo = initRepo()
  commit(repo, 'chore: base')
  tag(repo, 'comp/v1.0.0')
  for (const c of payload) commit(repo, c.subject, c.body)
  return repo
}

describe('price.sh — bump map totality (D18)', () => {
  it('feat → minor', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'feat: add thing' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.1.0')
  })

  it('fix → patch', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'fix: correct thing' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.1')
  })

  it('chore → patch', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'chore: bump deps' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.1')
  })

  it('docs → patch', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'docs: update readme' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.1')
  })

  it('refactor → patch', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'refactor: extract helper' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.1')
  })

  it('unknown/other conventional type → patch', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'wibble: something odd' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.1')
  })

  it('feat! (bang) → major', () => {
    const { code, stdout } = price(bumpFixture([{ subject: 'feat!: drop legacy api' }]), ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('2.0.0')
  })

  it('BREAKING CHANGE: in body → major (regardless of type)', () => {
    const repo = bumpFixture([{ subject: 'fix: reshape config', body: 'BREAKING CHANGE: renames the top-level key' }])
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('2.0.0')
  })

  it('mixed payload → highest bump wins (feat + fix + chore → minor)', () => {
    const repo = bumpFixture([
      { subject: 'chore: housekeeping' },
      { subject: 'fix: a bug' },
      { subject: 'feat: a feature' },
    ])
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.1.0')
  })

  it('mixed payload with a breaking change → major dominates', () => {
    const repo = bumpFixture([{ subject: 'feat: a feature' }, { subject: 'feat!: a breaking feature' }])
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('2.0.0')
  })

  it('empty payload (0 non-merge commits between BASE and HEAD) → derived == BASE, no bump', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    tag(repo, 'comp/v1.0.0') // tag AT head → nothing after it
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toBe('1.0.0')
  })
})

// ─── Case 4 — exit-code contract (D10) ─────────────────────────────────────────

describe('price.sh — exit contract (D10)', () => {
  it('zero-tags repo → exit 10 (first release)', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    commit(repo, 'feat: x')
    const { code } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(10)
  })

  it('tags exist but NONE reachable from ANCHOR → exit 10 with a signal distinct from zero-tags', () => {
    // Baseline: the zero-tags exit-10 case, to compare stderr against.
    const zeroRepo = initRepo()
    commit(zeroRepo, 'chore: init')
    const zero = price(zeroRepo, ['comp', 'main', 'main'])
    expect(zero.code).toBe(10)

    // A comp/v* tag exists but lives on an unrelated branch, unreachable from main.
    const repo = initRepo()
    commit(repo, 'chore: init') // main
    git(repo, ['checkout', '-q', '-b', 'other'])
    commit(repo, 'chore: elsewhere')
    tag(repo, 'comp/v0.5.0') // reachable from `other`, not from `main`
    git(repo, ['checkout', '-q', 'main'])

    const unreachable = price(repo, ['comp', 'main', 'main'])
    expect(unreachable.code).toBe(10)
    // The two exit-10 verdicts must NOT be conflated: unreachable-tags warns distinctly.
    expect(unreachable.stderr.length).toBeGreaterThan(0)
    expect(unreachable.stderr).not.toBe(zero.stderr)
  })

  it('normal → exit 0 + a bare X.Y.Z on stdout', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    tag(repo, 'comp/v0.3.0')
    commit(repo, 'fix: y')
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    expect(stdout).toMatch(/^\d+\.\d+\.\d+$/)
    expect(stdout).toBe('0.3.1')
  })

  it('missing args → exit ≥1 (not 0, not 10)', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    const { code } = price(repo, [])
    expect(code).toBeGreaterThanOrEqual(1)
    expect(code).not.toBe(10)
  })

  it('garbage ref args → exit ≥1 (not 0, not 10)', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    tag(repo, 'comp/v0.3.0')
    const { code } = price(repo, ['comp', 'no-such-ref-xyz', 'no-such-ref-xyz'])
    expect(code).toBeGreaterThanOrEqual(1)
    expect(code).not.toBe(10)
  })
})

// ─── Case 5 — semver hygiene: strict filter + sort -V ──────────────────────────

describe('price.sh — semver hygiene', () => {
  it('filters pre-release tags (only ^comp/v[0-9]+.[0-9]+.[0-9]+$ counts)', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    tag(repo, 'comp/v0.9.0')
    commit(repo, 'chore: cut 0.10.0')
    tag(repo, 'comp/v0.10.0')
    tag(repo, 'comp/v0.11.0-rc.1') // would be highest if NOT filtered → must be ignored
    commit(repo, 'feat: x')
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    // BASE resolves to 0.10.0 (rc filtered), feat after it → 0.11.0.
    expect(stdout).toBe('0.11.0')
  })

  it('sort -V picks comp/v0.10.0 over comp/v0.9.0 (numeric, not lexicographic)', () => {
    const repo = initRepo()
    commit(repo, 'chore: base')
    tag(repo, 'comp/v0.9.0')
    commit(repo, 'chore: cut 0.10.0') // only in payload if BASE is wrongly 0.9.0
    tag(repo, 'comp/v0.10.0')
    commit(repo, 'feat: x')
    const { code, stdout } = price(repo, ['comp', 'main', 'main'])
    expect(code).toBe(0)
    // Numeric max is 0.10.0 → feat → 0.11.0.
    // (Lexical order picks 0.9.0 as max → floor earlier → still-feat → 0.10.0.)
    expect(stdout).toBe('0.11.0')
  })
})
