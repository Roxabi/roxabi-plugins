import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const PREFLIGHT_SH = fileURLToPath(new URL('../preflight.sh', import.meta.url))

// Strip ambient GIT_* (a lefthook/pre-push hook exports GIT_DIR/GIT_WORK_TREE);
// without this a fixture case would operate on the real worktree instead of the
// throwaway dir (#532).
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v
  }
  return env
}

const FIXTURE_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix = 'preflight-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function writeStack(dir: string, yml: string): void {
  mkdirSync(join(dir, '.dev'), { recursive: true })
  writeFileSync(join(dir, '.dev', 'stack.yml'), yml)
}

function run(dir: string, env: NodeJS.ProcessEnv): { out: string; code: number } {
  const r = spawnSync('bash', [PREFLIGHT_SH], { cwd: dir, encoding: 'utf8', env })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? -1 }
}

function runPreflight(stackYml: string | null): { out: string; code: number } {
  const dir = tmp()
  if (stackYml !== null) writeStack(dir, stackYml)
  return run(dir, cleanEnv())
}

/**
 * A staging-train repo with a real `origin` remote carrying `main` and `staging`,
 * one commit ahead on staging. `git(...)` runs with GIT_* stripped and the
 * fixture identity forced, so nothing reaches the caller's repository.
 */
function stagingTrainRepo(): { work: string; origin: string; env: NodeJS.ProcessEnv } {
  const root = tmp('preflight-repo-')
  const origin = join(root, 'origin.git')
  const work = join(root, 'work')
  const env = { ...cleanEnv(), ...FIXTURE_ENV }
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env, stdio: 'ignore' })

  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env, stdio: 'ignore' })
  spawnSync('git', ['init', '-q', '-b', 'main', work], { env, stdio: 'ignore' })
  git(work, 'remote', 'add', 'origin', origin)
  writeFileSync(join(work, 'README.md'), 'base\n')
  writeStack(work, 'runtime: bun\n')
  git(work, 'add', 'README.md', '.dev/stack.yml')
  git(work, 'commit', '-q', '-m', 'chore: base')
  git(work, 'push', '-q', '-u', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'staging')
  writeFileSync(join(work, 'feature.txt'), 'work\n')
  git(work, 'add', 'feature.txt')
  git(work, 'commit', '-q', '-m', 'feat: a thing')
  git(work, 'push', '-q', '-u', 'origin', 'staging')
  // Sit on a feature branch, the normal omp-build posture: promote is invoked
  // from wherever the operator happens to be, not from staging.
  git(work, 'checkout', '-q', '-b', 'feat/1-thing')
  return { work, origin, env }
}

function head(work: string, env: NodeJS.ProcessEnv): string {
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).stdout.trim()
}

function branch(work: string, env: NodeJS.ProcessEnv): string {
  return spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work, env, encoding: 'utf8' }).stdout.trim()
}

describe('preflight.sh — trunk-mode guard (#371 N17)', () => {
  it('no-ops with status=trunk_mode when release.model is trunk, before any staging git op', () => {
    const { out, code } = runPreflight('release:\n  model: trunk\n  component: x\n')
    expect(out).toContain('status=trunk_mode')
    expect(code).toBe(0)
  })

  it('leaves a staging-train repo untouched — guard inert on the default model', () => {
    // No release: block → staging-train. The guard must not fire; preflight then
    // proceeds to its staging git ops (which fail in this non-repo dir — that is
    // fine, the point is only that trunk_mode is NOT emitted).
    const { out } = runPreflight('runtime: bun\n')
    expect(out).not.toContain('status=trunk_mode')
  })

  it('trunk WITH a staging branch → opens the create-PR path (trunk_promote_pr), not a blanket no-op (#371 B1)', () => {
    // The narrowed guard (B1): a repo mid-transition that keeps `staging` must
    // still be able to open the staging→main merge PR — merging lands the commits
    // on main, where an annotated tag may later name them. Falsifiable: reverting
    // to the blanket `status=trunk_mode; exit 0` guard makes this emit trunk_mode
    // and never reach the fall-through line.
    const dir = tmp()
    const env = { ...cleanEnv(), ...FIXTURE_ENV }
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env })
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env })
    spawnSync('git', ['branch', 'staging'], { cwd: dir, env })
    writeStack(dir, 'release:\n  model: trunk\n  component: x\n')
    const { out } = run(dir, env)
    // Fell through to the create-PR flow (the informational line is printed before
    // the later staging fetch fails in this origin-less repo).
    expect(out).toContain('status=trunk_promote_pr')
    expect(out).not.toContain('status=trunk_mode')
  })
})

describe('preflight.sh — read-only before the first question (#495)', () => {
  it('reports commits ahead without moving HEAD off the caller’s branch', () => {
    // dev-core's copy ran `git checkout staging && git pull origin staging` here,
    // i.e. it mutated the operator's worktree before printing a single number and
    // before any consent existed. Falsifiable in one line: restore either command
    // and `branch` becomes `staging` while `head` moves.
    const { work, env } = stagingTrainRepo()
    const before = { head: head(work, env), branch: branch(work, env) }

    const { out } = run(work, env)

    expect(out).toContain('commits_ahead=1')
    expect(out).toContain('status=ok')
    expect(branch(work, env)).toBe('feat/1-thing')
    expect(branch(work, env)).toBe(before.branch)
    expect(head(work, env)).toBe(before.head)
    expect(out).toContain('unchanged=feat/1-thing')
  })

  it('leaves the working tree and index clean', () => {
    // A pull that fast-forwards leaves no dirt either — what a `git status` here
    // catches is a merge that conflicted, or a stamped file. Both would mean the
    // script wrote into a tree the operator had not agreed to hand over.
    const { work, env } = stagingTrainRepo()
    run(work, env)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: work, env, encoding: 'utf8' }).stdout
    expect(status.trim()).toBe('')
  })

  it('refuses with a named ref instead of counting zero commits when the mirror lacks one', () => {
    // The silent failure this replaces: with `origin/main` unresolvable,
    // `git log origin/main..origin/staging` errors, `2>/dev/null` swallows it,
    // `wc -l` counts zero, and the operator is told "nothing to promote" about a
    // repo with plenty to promote.
    //
    // Reached through a narrowed `remote.origin.fetch`: the fetch succeeds (both
    // branches exist upstream) but only writes back the staging mirror, so
    // `origin/main` stays absent across the fetch. Deleting the branch upstream
    // instead would fail earlier, at `status=fetch_failed` — which is already a
    // named refusal and not the case under test.
    const { work, env } = stagingTrainRepo()
    const git = (...args: string[]) => spawnSync('git', args, { cwd: work, env, stdio: 'ignore' })
    git('config', 'remote.origin.fetch', '+refs/heads/staging:refs/remotes/origin/staging')
    git('update-ref', '-d', 'refs/remotes/origin/main')

    const { out, code } = run(work, env)
    expect(out).toContain('status=missing_ref:origin/main')
    expect(out).not.toContain('status=nothing_to_promote')
    expect(out).not.toContain('commits_ahead=')
    expect(code).toBe(1)
  })
})
