import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
    // Drop registration without deleting the worktree directory.
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: repo,
      env: { ...FIXTURE_ENV, HOME: home },
      encoding: 'utf8',
    }).trim()
    const commonAbs = path.isAbsolute(common) ? common : path.join(repo, common)
    const admin = path.join(commonAbs, 'worktrees', path.basename(staleGit))
    rmSync(admin, { recursive: true, force: true })

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
})
