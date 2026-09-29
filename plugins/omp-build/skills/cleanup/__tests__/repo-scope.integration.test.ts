import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * #622: orphan-shell scan must not offer another same-named repo's live
 * worktree, the principal's own tree, or unregistered+.git rows under `--yes`.
 */
const SCAN = path.resolve(import.meta.dirname, '..', 'scan-orphan-worktree-shells.sh')

const FIXTURE_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
}

let root: string | undefined

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function initRepo(dir: string, home: string): void {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, env: { ...FIXTURE_ENV, HOME: home }, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(dir, 'README.md'), 'base\n')
  git('add', 'README.md')
  git('commit', '-q', '-m', 'chore: base')
}

function scan(repo: string, env: NodeJS.ProcessEnv, args: string[] = []): string[] {
  const out = execFileSync('bash', [SCAN, ...args], {
    cwd: repo,
    env: { ...FIXTURE_ENV, ...env },
    encoding: 'utf8',
  })
  return out.split('\n').filter((line) => line.includes('|'))
}

describe('cleanup orphan scan repo scope (#622)', () => {
  it('never lists a live worktree of another same-named repository', () => {
    // Shared ~/.omp/wt/<basename>/ — orgA and orgB both check out "app".
    // Scanning from orgB must not offer orgA's live worktree for rm -rf.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-same-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    mkdirSync(home)
    const orgA = path.join(root, 'orgA', 'app')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgA, home)
    initRepo(orgB, home)

    const foreignLive = path.join(base, 'app', 'feat-7-operator-work')
    mkdirSync(path.dirname(foreignLive), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', foreignLive, '-b', 'feat/7-operator-work'], {
      cwd: orgA,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })
    writeFileSync(path.join(foreignLive, 'NOTES.md'), 'uncommitted\n')

    // Real orphan of orgB still reported (content without .git).
    const ourOrphan = path.join(base, 'app', 'feat-9-leftover')
    mkdirSync(path.join(ourOrphan, 'node_modules'), { recursive: true })

    const reported = scan(orgB, { HOME: home, OMP_WORKTREE_DIR: base })
    const paths = reported.map((line) => line.split('|')[0])

    expect(paths.map((p) => realpathSync(p))).not.toContain(realpathSync(foreignLive))
    expect(reported.some((line) => line.includes(foreignLive))).toBe(false)
    expect(paths.map((p) => realpathSync(p))).toContain(realpathSync(ourOrphan))
  })

  it('never lists the principal or its descendants when base is the principal parent', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-principal-')))
    const home = path.join(root, 'home')
    const projects = path.join(root, 'projects')
    mkdirSync(home)
    const principal = path.join(projects, 'app')
    initRepo(principal, home)
    mkdirSync(path.join(principal, 'src'), { recursive: true })
    writeFileSync(path.join(principal, 'src', 'main.ts'), 'export {}\n')
    mkdirSync(path.join(principal, 'node_modules', 'leftpad'), { recursive: true })

    // Harness orphan under .claude/worktrees must still surface.
    const claudeOrphan = path.join(principal, '.claude', 'worktrees', '495-optional-tail')
    mkdirSync(path.join(claudeOrphan, 'node_modules'), { recursive: true })

    const reported = scan(principal, { HOME: home, OMP_WORKTREE_DIR: projects })
    const paths = reported.map((line) => realpathSync(line.split('|')[0]))

    expect(paths).not.toContain(realpathSync(principal))
    expect(paths).not.toContain(realpathSync(path.join(principal, 'src')))
    expect(paths).not.toContain(realpathSync(path.join(principal, 'node_modules')))
    expect(paths).toContain(realpathSync(claudeOrphan))
  })

  it('omits unregistered-with-.git from --yes-targets while still listing them fully', () => {
    // Half-removed worktree of THIS repo: directory + gitdir file survive, admin
    // entry gone → unregistered with .git belonging to us.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-yes-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    mkdirSync(home)
    const repo = path.join(root, 'app')
    initRepo(repo, home)

    const staleGit = path.join(base, 'app', 'feat-3-stale-git')
    mkdirSync(path.dirname(staleGit), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', staleGit, '-b', 'feat/3-stale-git'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })
    // Drop registration without deleting the worktree directory — prune the
    // whole worktrees/ dir as git does, not just the one entry.
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      encoding: 'utf8',
    }).trim()
    rmSync(path.join(common, 'worktrees'), { recursive: true, force: true })

    const emptyOrphan = path.join(base, 'app', 'feat-4-empty')
    mkdirSync(emptyOrphan, { recursive: true })

    const contentOrphan = path.join(base, 'app', 'feat-5-content')
    mkdirSync(path.join(contentOrphan, 'node_modules'), { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])

    const fullPaths = full.map((line) => realpathSync(line.split('|')[0]))
    const yesPaths = yesTargets.map((line) => realpathSync(line.split('|')[0]))

    expect(fullPaths).toContain(realpathSync(staleGit))
    expect(full.some((line) => line.includes('has .git') && line.includes(staleGit))).toBe(true)

    // Pre-select / --yes set: empty + content-without-git only.
    expect(yesPaths).not.toContain(realpathSync(staleGit))
    expect(yesTargets.some((line) => line.includes('has .git'))).toBe(false)
    expect(yesPaths).toContain(realpathSync(emptyOrphan))
    expect(yesPaths).toContain(realpathSync(contentOrphan))
  })

  it('ownership proof holds when scanning from a subdirectory of the principal', () => {
    // Plain `--git-common-dir` is cwd-relative; joining it to $repo_root from
    // <repo>/src made ours_worktrees wrong — this repo's half-removed vanished
    // and a foreign same-named live worktree could reappear.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-subdir-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    mkdirSync(home)
    const orgA = path.join(root, 'orgA', 'app')
    const orgB = path.join(root, 'orgB', 'app')
    initRepo(orgA, home)
    initRepo(orgB, home)
    mkdirSync(path.join(orgB, 'src'), { recursive: true })

    const foreignLive = path.join(base, 'app', 'feat-7-foreign')
    mkdirSync(path.dirname(foreignLive), { recursive: true })
    execFileSync('git', ['worktree', 'add', '-q', foreignLive, '-b', 'feat/7-foreign'], {
      cwd: orgA,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })

    const oursStale = path.join(base, 'app', 'feat-8-ours-stale')
    execFileSync('git', ['worktree', 'add', '-q', oursStale, '-b', 'feat/8-ours-stale'], {
      cwd: orgB,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: orgB,
      env: { ...FIXTURE_ENV, HOME: home },
      encoding: 'utf8',
    }).trim()
    rmSync(path.join(common, 'worktrees'), { recursive: true, force: true })

    const reported = scan(path.join(orgB, 'src'), { HOME: home, OMP_WORKTREE_DIR: base })
    const paths = reported.map((line) => line.split('|')[0])

    expect(reported.some((line) => line.includes(foreignLive))).toBe(false)
    expect(paths.map((p) => realpathSync(p))).toContain(realpathSync(oursStale))
    expect(reported.some((line) => line.includes('has .git') && line.includes(oursStale))).toBe(true)
  })

  it('lists a relative-paths half-removed worktree after worktrees/ is fully pruned', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-rel-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    mkdirSync(home)
    const repo = path.join(root, 'app')
    initRepo(repo, home)
    execFileSync('git', ['config', 'worktree.useRelativePaths', 'true'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })

    const stale = path.join(base, 'app', 'feat-rel-stale')
    mkdirSync(path.dirname(stale), { recursive: true })
    execFileSync('git', ['worktree', 'add', '--relative-paths', '-q', stale, '-b', 'feat/rel-stale'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      stdio: 'ignore',
    })
    // Confirm the back-pointer is relative, then prune the whole admin dir.
    const gitdirLine = execFileSync('head', ['-n1', path.join(stale, '.git')], { encoding: 'utf8' }).trim()
    expect(gitdirLine.startsWith('gitdir:')).toBe(true)
    expect(gitdirLine.includes('..')).toBe(true)

    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      encoding: 'utf8',
    }).trim()
    rmSync(path.join(common, 'worktrees'), { recursive: true, force: true })

    const full = scan(repo, { HOME: home, OMP_WORKTREE_DIR: base })
    expect(full.map((line) => realpathSync(line.split('|')[0]))).toContain(realpathSync(stale))
    expect(full.some((line) => line.includes('has .git') && line.includes(stale))).toBe(true)
  })

  it('never puts a symlink child pointing outside the root into --yes-targets', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-symlink-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    const outside = path.join(root, 'important')
    mkdirSync(home)
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'secret.txt'), 'keep\n')
    const repo = path.join(root, 'app')
    initRepo(repo, home)

    const linkChild = path.join(base, 'app', 'linkchild')
    mkdirSync(path.dirname(linkChild), { recursive: true })
    symlinkSync(outside, linkChild)

    const contentOrphan = path.join(base, 'app', 'feat-ok')
    mkdirSync(path.join(contentOrphan, 'node_modules'), { recursive: true })

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])

    // Lexical entry may appear as symlink kind — never the outside target, never --yes.
    expect(yesTargets.some((line) => line.includes(outside) || line.includes(linkChild))).toBe(false)
    expect(full.some((line) => line.startsWith(`${linkChild}|symlink|`))).toBe(true)
    expect(yesTargets.map((line) => realpathSync(line.split('|')[0]))).toContain(realpathSync(contentOrphan))
  })

  it('never lists a base child that contains the principal', () => {
    // Basename "app", base=projects → scan projects/app. Depth-1 child "org"
    // contains the principal at projects/app/org/app — must not be deletable.
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-contains-')))
    const home = path.join(root, 'home')
    mkdirSync(home)
    const projects = path.join(root, 'projects')
    const principal = path.join(projects, 'app', 'org', 'app')
    initRepo(principal, home)
    const container = path.join(projects, 'app', 'org')
    mkdirSync(path.join(container, 'extra'), { recursive: true })
    writeFileSync(path.join(container, 'extra', 'x'), 'x\n')

    const reported = scan(principal, { HOME: home, OMP_WORKTREE_DIR: projects })
    const yesTargets = scan(principal, { HOME: home, OMP_WORKTREE_DIR: projects }, ['--yes-targets'])
    expect(reported.some((line) => line.includes(container))).toBe(false)
    expect(yesTargets.some((line) => line.includes(container))).toBe(false)
  })

  it('reports forged control/| names as unsafe_name and keeps them out of --yes-targets', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-unsafe-')))
    const home = path.join(root, 'home')
    const base = path.join(root, 'wt')
    mkdirSync(home)
    const repo = path.join(root, 'app')
    initRepo(repo, home)

    const pipeName = path.join(base, 'app', 'bad|name')
    mkdirSync(pipeName, { recursive: true })
    writeFileSync(path.join(pipeName, 'f'), 'x\n')

    const nlName = path.join(base, 'app', 'bad\nname')
    mkdirSync(nlName, { recursive: true })
    writeFileSync(path.join(nlName, 'f'), 'x\n')

    const env = { HOME: home, OMP_WORKTREE_DIR: base }
    const full = scan(repo, env)
    const yesTargets = scan(repo, env, ['--yes-targets'])

    expect(full.some((line) => line.includes('|unsafe_name|'))).toBe(true)
    expect(yesTargets.some((line) => line.includes('unsafe_name'))).toBe(false)
    expect(yesTargets.some((line) => line.includes('bad|name') || line.includes('bad\nname'))).toBe(false)
  })

  it('does not emit an empty root inside the principal', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-empty-root-')))
    const home = path.join(root, 'home')
    mkdirSync(home)
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    // Empty .claude/worktrees is under principal but exempt as claude_root —
    // an empty *legacy* root under principal is the case: point OMP_WORKTREES_ROOT
    // inside principal.
    const legacy = path.join(principal, '.omp-legacy', 'worktrees', 'app')
    mkdirSync(legacy, { recursive: true })

    const full = scan(principal, {
      HOME: home,
      OMP_WORKTREES_ROOT: path.join(principal, '.omp-legacy', 'worktrees'),
      OMP_WORKTREE_DIR: path.join(root, 'wt-elsewhere'),
    })
    const yesTargets = scan(
      principal,
      {
        HOME: home,
        OMP_WORKTREES_ROOT: path.join(principal, '.omp-legacy', 'worktrees'),
        OMP_WORKTREE_DIR: path.join(root, 'wt-elsewhere'),
      },
      ['--yes-targets'],
    )
    expect(full.some((line) => line.includes(legacy))).toBe(false)
    expect(yesTargets.some((line) => line.includes(legacy))).toBe(false)
  })

  it('lists orphans under an in-principal worktree.base', () => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'omp-build-622-inprin-')))
    const home = path.join(root, 'home')
    mkdirSync(home)
    const principal = path.join(root, 'app')
    initRepo(principal, home)
    // OMP_WORKTREE_DIR = principal → feature_root = principal/app (exempt).
    const orphan = path.join(principal, 'app', 'feat-in')
    mkdirSync(path.join(orphan, 'node_modules'), { recursive: true })

    const reported = scan(principal, { HOME: home, OMP_WORKTREE_DIR: principal })
    expect(reported.map((line) => line.split('|')[0])).toContain(orphan)
    expect(reported.some((line) => line.includes('content without git registration'))).toBe(true)
  })
})
