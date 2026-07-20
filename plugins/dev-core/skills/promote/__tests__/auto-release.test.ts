import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Bare `origin` + a `gh` shim, i.e. everything the non-dry-run path needs to run
 * for real without a network. Returns the env to invoke the orchestrator with.
 */
function enactmentFixture(repo: string): { runEnv: NodeJS.ProcessEnv; ghLog: string } {
  const origin = mkdtempSync(join(tmpdir(), 'auto-release-origin-'))
  createdRepos.push(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', 'origin', 'main'])

  const bin = mkdtempSync(join(tmpdir(), 'auto-release-bin-'))
  createdRepos.push(bin)
  const ghLog = join(bin, 'gh.log')
  const marker = join(bin, 'release.created')
  const ghShim = join(bin, 'gh')
  writeFileSync(
    ghShim,
    [
      '#!/usr/bin/env bash',
      'echo "gh $*" >> "$GH_SHIM_LOG"',
      'case "$1 $2" in',
      '  "release view")   [ -f "$GH_SHIM_MARKER" ] && exit 0 || exit 1 ;;',
      '  "release create") : > "$GH_SHIM_MARKER"; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  )
  chmodSync(ghShim, 0o755)

  return {
    ghLog,
    runEnv: {
      ...gitEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GH_SHIM_LOG: ghLog,
      GH_SHIM_MARKER: marker,
      GH_TOKEN: 'shim',
    },
  }
}

/** Strip every committer/author identity var — the state a bare CI runner is in. */
function withoutIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) continue
    out[key] = value
  }
  return out
}

/**
 * Force the runner's exact failure mode, deterministically.
 *
 * Stripping GIT_COMMITTER_* is NOT enough: git still auto-derives an identity
 * from the passwd entry, so on a dev box with a populated gecos field the tag
 * succeeds and the regression hides. The runner failed precisely because its
 * gecos is empty — it derived an email (`runner@runnervm...`) but no NAME, hence
 * `fatal: empty ident name`. useConfigOnly makes git refuse to derive either,
 * reproducing that on any host instead of only on gecos-less ones.
 */
function forbidDerivedIdentity(repo: string): void {
  git(repo, ['config', 'user.useConfigOnly', 'true'])
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

// ─── W3 — real enactment (NOT --dry-run): git tag + git push + gh release create ─
//
// Every case above runs --dry-run, so `git tag/push` + `gh release create`
// (auto-release.sh:111,112,118) never execute — a bug there would surface only on
// the first real release (the dogfood). This case runs the orchestrator for real
// against a bare `origin` and a `gh` shim that records argv, asserting the tag is
// created, pushed, and the release is requested exactly once (idempotent D16).

describe('auto-release.sh — real enactment path (W3)', () => {
  it('2-parent feat merge (no --dry-run) → tags at M, pushes to origin, creates the release once', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // derived → 0.8.0

    // Bare origin so `git push origin <tag>` has a writable remote (no network).
    const origin = mkdtempSync(join(tmpdir(), 'auto-release-origin-'))
    createdRepos.push(origin)
    git(origin, ['init', '-q', '--bare', '-b', 'main'])
    git(repo, ['remote', 'add', 'origin', origin])
    git(repo, ['push', '-q', 'origin', 'main'])

    // `gh` shim: `release view` fails until `release create` runs (writes a marker),
    // so the reconcile loop converges tag → create-release → noop (D16). All argv
    // is appended to a log we assert on.
    const bin = mkdtempSync(join(tmpdir(), 'auto-release-bin-'))
    createdRepos.push(bin)
    const ghLog = join(bin, 'gh.log')
    const marker = join(bin, 'release.created')
    const ghShim = join(bin, 'gh')
    writeFileSync(
      ghShim,
      [
        '#!/usr/bin/env bash',
        'echo "gh $*" >> "$GH_SHIM_LOG"',
        'case "$1 $2" in',
        '  "release view")   [ -f "$GH_SHIM_MARKER" ] && exit 0 || exit 1 ;;',
        '  "release create") : > "$GH_SHIM_MARKER"; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )
    chmodSync(ghShim, 0o755)

    const runEnv = {
      ...gitEnv(),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GH_SHIM_LOG: ghLog,
      GH_SHIM_MARKER: marker,
      GH_TOKEN: 'shim',
    }
    const r = spawnSync('bash', [AUTO_RELEASE_SH, 'comp', m], { cwd: repo, encoding: 'utf8', env: runEnv })
    const stdout = (r.stdout ?? '').trim()

    expect(r.status, `stderr:\n${r.stderr}`).toBe(0)
    expect(stdout).toMatch(/tag: comp\/v0\.8\.0/)
    expect(stdout).toContain('create-release: comp/v0.8.0')
    // Tag was really created at M and pushed to origin.
    expect(git(repo, ['rev-list', '-n1', 'comp/v0.8.0'])).toBe(m)
    expect(git(repo, ['ls-remote', '--tags', 'origin'])).toContain('comp/v0.8.0')
    // Release was requested exactly once (idempotent — the loop stops once it exists).
    const ghCalls = readFileSync(ghLog, 'utf8')
    expect(ghCalls).toMatch(/gh release create comp\/v0\.8\.0/)
    expect((ghCalls.match(/release create /g) ?? []).length).toBe(1)
  })
})

// ─── W4 — annotated-tag identity on a bare runner (#376 dogfood regression) ────
//
// The W3 case above runs the enactment path for real, but through gitEnv(), which
// exports GIT_COMMITTER_NAME/EMAIL. A GitHub runner exports neither and has no
// git config, so `git tag -a` died `fatal: empty ident name` (exit 128) on the
// very first Model-B release — after price.sh had correctly derived v0.5.0. The
// harness supplied the one thing production lacked, so 823 green tests said
// nothing. These cases remove it.

describe('auto-release.sh — annotated tag with no committer identity (#376)', () => {
  it('bare runner (no git config, no GIT_COMMITTER_*) → still tags, pushes, releases', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // derived → 0.8.0

    const { runEnv, ghLog } = enactmentFixture(repo)
    forbidDerivedIdentity(repo)
    const r = spawnSync('bash', [AUTO_RELEASE_SH, 'comp', m], {
      cwd: repo,
      encoding: 'utf8',
      env: withoutIdentity(runEnv),
    })

    expect(r.status, `stderr:\n${r.stderr}`).toBe(0)
    expect(r.stderr).not.toMatch(/empty ident name/)
    // The annotated tag really exists at M and reached origin.
    expect(git(repo, ['cat-file', '-t', 'comp/v0.8.0'])).toBe('tag')
    expect(git(repo, ['rev-list', '-n1', 'comp/v0.8.0'])).toBe(m)
    expect(git(repo, ['ls-remote', '--tags', 'origin'])).toContain('comp/v0.8.0')
    expect(readFileSync(ghLog, 'utf8')).toMatch(/gh release create comp\/v0\.8\.0/)
  })

  it('a configured identity is left alone (gap-fill, not override)', () => {
    const repo = initRepo()
    commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature')

    const { runEnv } = enactmentFixture(repo)
    forbidDerivedIdentity(repo)
    git(repo, ['config', 'user.name', 'Repo Owner'])
    git(repo, ['config', 'user.email', 'owner@example.com'])

    const r = spawnSync('bash', [AUTO_RELEASE_SH, 'comp', m], {
      cwd: repo,
      encoding: 'utf8',
      env: withoutIdentity(runEnv),
    })

    expect(r.status, `stderr:\n${r.stderr}`).toBe(0)
    expect(git(repo, ['config', '--get', 'user.email'])).toBe('owner@example.com')
    expect(git(repo, ['for-each-ref', '--format=%(taggeremail)', 'refs/tags/comp/v0.8.0'])).toContain(
      'owner@example.com',
    )
  })
})

// ─── W5 — cut-from-main invariant (FU-1) ───────────────────────────────────────
//
// auto-release.yml's `workflow_dispatch` carries no ref constraint, so before the
// job-level `if: github.ref == refs/heads/main` guard a dispatch on any branch ran
// this contents:write job with the App token against that branch's tip and could
// publish a real tag + GitHub Release from unreviewed commits. The `if:` is the CI
// control; auto-release.sh's ancestry check is the script-level echo for every
// other caller. It REFUSEs only on a POSITIVE "not reachable from origin/main",
// and is a deliberate no-op when origin/main is unresolvable (a full-history
// checkout does not reliably populate remote-tracking refs) so it can never red a
// legitimate release.

describe('auto-release.sh — cut-from-main invariant (FU-1)', () => {
  it('a 2-parent merge NOT reachable from origin/main → REFUSE (exit 1, nothing released)', () => {
    const repo = initRepo()
    const c0 = commit(repo, 'chore: init')
    tag(repo, 'comp/v0.7.0')
    // origin/main is pinned to the tagged init commit — it does NOT contain the
    // rogue merge built below. update-ref (not push) so the exclusion is exact
    // regardless of how a given git version mirrors push into remote-tracking refs.
    git(repo, ['update-ref', 'refs/remotes/origin/main', c0])

    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', '-b', 'rogue', 'main']) // off main, at the init commit
    const m = mergeNoFf(repo, 'feature', 'Merge feature') // 2-parent merge, lives only on rogue

    // NOT --dry-run: the REFUSE must fire before any tag/push/gh. A regression that
    // dropped the ancestry check would proceed to derive 0.8.0 and tag it here.
    const { code, stderr } = autoRelease(repo, ['comp', m])
    expect(code).toBe(1)
    expect(stderr).toMatch(/not reachable from origin\/main/)
    // Proof nothing was cut: the derived tag was never created.
    expect(git(repo, ['tag', '-l', 'comp/v0.8.0'])).toBe('')
  })

  it('origin/main unresolvable → ancestry guard is a no-op, never reds a release (dry-run)', () => {
    const repo = initRepo()
    commit(repo, 'chore: init') // no tag → first-release path; no origin/main ref set
    git(repo, ['checkout', '-q', '-b', 'feature'])
    commit(repo, 'feat: x')
    git(repo, ['checkout', '-q', 'main'])
    const m = mergeNoFf(repo, 'feature', 'Merge feature')

    const { code, stderr } = autoRelease(repo, ['--dry-run', 'comp', m])
    expect(code).toBe(0)
    expect(stderr).not.toMatch(/not reachable from origin\/main/)
  })
})
