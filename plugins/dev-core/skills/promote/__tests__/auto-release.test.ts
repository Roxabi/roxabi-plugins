import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// The trunk-mode (Model B, #371) release orchestrator under test. It reuses
// price.sh (deriver) + finalize.ts (classifier) — no second copy of the
// derive/classify/reconcile logic. Does not exist yet → RED until S2-T5 lands.
// Resolved relative to this file so it survives the worktree being merged.
const AUTO_RELEASE_SH = fileURLToPath(new URL('../auto-release.sh', import.meta.url))
const AUTO_RELEASE_SRC = (): string => readFileSync(AUTO_RELEASE_SH, 'utf8')

// ─── Synthetic-git-fixture harness (mirrors price.test.ts, hook-safe) ───────────
//
// Every case builds a THROWAWAY git repo reproducing a TOPOLOGY. Author/committer
// dates are fixed + monotonic so the DAG — not commit order — is what the
// orchestrator reads. GIT_* location vars are stripped so an ambient GIT_DIR from
// a pre-push hook can never redirect fixture commits into the real worktree (#353).

const createdRepos: string[] = []
afterAll(() => {
  for (const dir of createdRepos) rmSync(dir, { recursive: true, force: true })
})

let clock = 0
function gitEnv(): NodeJS.ProcessEnv {
  clock += 1
  const stamp = `@${1735689600 + clock} +0000` // 2025-01-01T00:00:00Z + clock seconds
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue
    env[key] = value
  }
  return {
    ...env,
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
  const dir = mkdtempSync(join(tmpdir(), 'auto-release-fixture-'))
  createdRepos.push(dir)
  git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

/** Empty commit on the current branch (topology is all that matters) → its SHA. */
function commit(repo: string, subject: string): string {
  git(repo, ['commit', '--allow-empty', '-m', subject])
  return git(repo, ['rev-parse', 'HEAD'])
}

function tag(repo: string, name: string, ref = 'HEAD'): void {
  git(repo, ['tag', name, ref])
}

/** Real --no-ff merge of `branch` into the checked-out branch → merge SHA (2 parents). */
function mergeNoFf(repo: string, branch: string, subject: string): string {
  git(repo, ['merge', '--no-ff', '-m', subject, branch])
  return git(repo, ['rev-parse', 'HEAD'])
}

/**
 * Fabricate a 2-parent merge with an EMPTY payload. Every real conventional
 * commit bumps ≥ patch, so a natural merge always has a non-empty payload; the
 * only empty-payload 2-parent merge is one whose second parent is already
 * reachable from the base. commit-tree builds exactly that: parents (main, base),
 * both reachable from the tag floor → rev-list ^BASE M = ∅.
 */
function emptyMerge(repo: string, firstParent: string, secondParent: string, subject: string): string {
  const tree = git(repo, ['rev-parse', `${firstParent}^{tree}`])
  return git(repo, ['commit-tree', tree, '-p', firstParent, '-p', secondParent, '-m', subject])
}

interface RunResult {
  stdout: string
  stderr: string
  code: number
}
function autoRelease(repo: string, args: string[]): RunResult {
  const r = spawnSync('bash', [AUTO_RELEASE_SH, ...args], { cwd: repo, encoding: 'utf8', env: gitEnv() })
  return { stdout: (r.stdout ?? '').trim(), stderr: r.stderr ?? '', code: r.status ?? -1 }
}

// ─── S2-T4 — derivation topologies (dry-run: decide, do not push) ───────────────

describe('auto-release.sh — derivation topologies (#371 S2)', () => {
  it('2-parent merge with a feat payload → tag the derived minor', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature')

    const { code, stdout } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(0)
    expect(stdout).toContain('tag: comp/v0.8.0')
  })

  it('stray 1-parent commit on main → loud-red REFUSE (exit 1, no release)', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    const c1 = commit(repo, 'feat: direct push') // linear, 1 parent

    const { code, stderr } = autoRelease(repo, ['--dry-run', 'comp', c1])
    expect(code).toBe(1)
    expect(stderr).toMatch(/REFUSE/)
    expect(stderr).toMatch(/2/) // "not 2" / "require a merge commit"
  })

  it('2-parent merge with an empty payload → green no-op (exit 0, nothing released)', () => {
    const repo = initRepo()
    const c0 = commit(repo, 'chore: init')
    const c1 = commit(repo, 'chore: more') // base tag sits on the tip
    tag(repo, 'comp/v1.0.0') // at c1 (HEAD)
    // Distinct parents, both reachable from the tag floor c1 → rev-list ^c1 M = ∅.
    const m = emptyMerge(repo, c1, c0, 'Merge (empty payload)')

    const { code, stdout } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(0)
    expect(stdout).toMatch(/noop|empty/)
    expect(stdout).not.toContain('tag: comp/')
  })

  it('tag for the derived version already points elsewhere → drift REFUSE (exit 1)', () => {
    const repo = initRepo()
    const c0 = commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // derived → 0.8.0
    // Drift tag on a sidetrack commit (child of c0), NOT reachable from M^1=c0 —
    // so it does not raise BASE, but the derived tag comp/v0.8.0 points ≠ M.
    git(repo, ['checkout', '-q', '-b', 'sidetrack', c0])
    const co = commit(repo, 'chore: side')
    tag(repo, 'comp/v0.8.0', co)
    git(repo, ['checkout', '-q', 'main'])

    const { code, stderr } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(1)
    expect(stderr).toMatch(/REFUSE/)
  })

  it('no reachable component tag → first release 0.1.0', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // no comp/v* tags anywhere

    const { code, stdout } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(0)
    expect(stdout).toContain('comp/v0.1.0')
  })
})

// ─── S2-T2 — core reuse (no second copy of derive/classify/reconcile) ───────────

describe('auto-release.sh — reuses price.sh + finalize.ts (no second copy)', () => {
  const src = AUTO_RELEASE_SRC()

  it('derives BOTH the version and the BASE floor from price.sh (M^1 anchor)', () => {
    expect(src).toMatch(/price\.sh"?\s+"?\$?\{?COMPONENT/) // price.sh COMPONENT M^1 M
    expect(src).toContain('M}^1') // the ${M}^1 first-parent anchor
    expect(src).toContain('--base-only')
  })

  it('counts parents via `git rev-list --parents … | wc -w` (never --count)', () => {
    expect(src).toContain('rev-list --parents -n1')
    expect(src).toContain('wc -w')
    expect(src).not.toContain('rev-list --count --parents')
  })

  it('classifies via finalize.ts with --is-promote true (trunk merges are always promotes)', () => {
    expect(src).toContain('finalize.ts')
    expect(src).toContain('--is-promote true')
    expect(src).toContain('--tag-state')
    expect(src).toContain('--release-state')
  })

  it('reconciles tag + release in a bounded loop and REFUSEs loud (exit 1)', () => {
    expect(src).toMatch(/for _ in 1 2 3/)
    expect(src).toMatch(/exit 1/)
  })

  it('does not re-implement version derivation (no inline semver bump arithmetic)', () => {
    // The bump map lives in price.sh; auto-release.sh must not carry a copy.
    expect(src).not.toMatch(/MA=\$\(\(MA \+ 1\)\)/)
    expect(src).not.toMatch(/BREAKING[ -]CHANGE/)
  })
})

// ─── S2-T6 — partial-failure recovery (D16): tag present, release absent ────────

describe('auto-release.sh — partial-failure recovery (D16)', () => {
  it('tag already at M + release absent → create-release only (idempotent, no duplicate tag)', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // derived → 0.8.0
    tag(repo, 'comp/v0.8.0', m) // tag already created at M (a finalize that died after tagging)

    const { code, stdout } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(0)
    expect(stdout).toContain('create-release: comp/v0.8.0')
    // Idempotence: the tag already points at M, so we must NOT tag again.
    expect(stdout).not.toMatch(/^tag: comp\/v0\.8\.0/m)
  })
})
