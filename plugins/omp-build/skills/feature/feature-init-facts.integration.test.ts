import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hermeticGh } from './__fixtures__/feature-init/hermetic'
import { FIXTURE_NAMES, FIXTURES, stageFixture } from './__fixtures__/feature-init/stage'

const FEATURE_DIR = path.resolve(import.meta.dirname)
const CLI = path.join(FEATURE_DIR, 'feature-init.ts')
const WORKFLOW = path.join(FEATURE_DIR, 'workflow.js')
const ISSUE_TRIAGE_SRC = path.resolve(FEATURE_DIR, '../../../issue-triage')
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const ARGV = readFileSync(path.join(FIXTURES, 'acme', 'gh', 'label-list.argv'), 'utf8')
  .trim()
  .split('\n')
const LABELS = readFileSync(path.join(FIXTURES, 'acme', 'gh', 'labels.txt'), 'utf8')

let root: string | undefined
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  execFileSync('git', args, { cwd, env, stdio: 'ignore' })
}

/** A committed copy of the acme fixture with an origin and an upstream remote. */
function acmeRepo(dest: string, env: NodeJS.ProcessEnv): string {
  stageFixture('acme', dest)
  git(dest, env, 'init', '-q', '-b', 'main')
  git(dest, env, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
  git(dest, env, 'remote', 'add', 'upstream', 'git@github.com:acme/kit-upstream.git')
  git(dest, env, 'add', '.')
  git(dest, env, 'commit', '-q', '-m', 'chore: fixture')
  return dest
}

/** omp-build and issue-triage installed as siblings under node_modules, both symlinked into a cache dir. */
function installedCli(base: string, issueTriage: 'present' | 'absent' | 'broken'): string {
  const cache = path.join(base, 'cache')
  const ompBuild = path.join(cache, 'omp-build-0.0.0')
  const nodeModules = path.join(base, 'node_modules')
  mkdirSync(path.join(ompBuild, 'skills', 'feature'), { recursive: true })
  mkdirSync(nodeModules, { recursive: true })
  writeFileSync(path.join(ompBuild, 'package.json'), JSON.stringify({ name: 'omp-build', type: 'module' }))
  cpSync(CLI, path.join(ompBuild, 'skills', 'feature', 'feature-init.ts'))
  symlinkSync(ompBuild, path.join(nodeModules, 'omp-build'))
  if (issueTriage !== 'absent') {
    const installed = path.join(cache, 'issue-triage-0.0.0')
    const lib = path.join(installed, 'skills', 'issue-triage', 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: 'issue-triage', type: 'module' }))
    if (issueTriage === 'broken') {
      writeFileSync(path.join(lib, 'migrate-labels.ts'), "throw new Error('widget grammar exploded')\n")
    } else {
      cpSync(
        path.join(ISSUE_TRIAGE_SRC, 'skills/issue-triage/lib/migrate-labels.ts'),
        path.join(lib, 'migrate-labels.ts'),
      )
    }
    symlinkSync(installed, path.join(nodeModules, 'issue-triage'))
  }
  return path.join(nodeModules, 'omp-build', 'skills', 'feature', 'feature-init.ts')
}

describe('feature init installed layout', () => {
  it('prints label migration when issue-triage is a sibling under node_modules', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-installed-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const target = acmeRepo(path.join(root, 'target'), gh.env)
    const result = spawnSync(REAL_BUN, [installedCli(root, 'present'), '--dir', target, '--dry-run'], {
      env: gh.env,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('label migration')
    expect(gh.calls()).toEqual([ARGV])
  })

  it('prints init=blocked issue-triage missing with exit 3 when the sibling is absent', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-blocked-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const target = acmeRepo(path.join(root, 'target'), gh.env)
    const result = spawnSync(REAL_BUN, [installedCli(root, 'absent'), '--dir', target, '--dry-run'], {
      env: gh.env,
      encoding: 'utf8',
    })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      'init=blocked issue-triage missing (not found next to omp-build or in node_modules)',
    )
    expect(result.stdout).toBe('')
  })
})

describe('feature init names the github.com host', () => {
  it('passes -R github.com/owner/repo even when GH_HOST points elsewhere', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-ghhost-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const env = { ...gh.env, GH_HOST: 'ghe.example' }
    const target = acmeRepo(path.join(root, 'target'), env)
    const result = spawnSync(REAL_BUN, [CLI, '--dir', target, '--dry-run'], { env, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(gh.calls()).toEqual([ARGV])
    expect(gh.calls()[0]).toContain('github.com/acme/app')
  })
})

describe('feature init with a broken issue-triage', () => {
  it('exits 3 and names the load error, not a missing package', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-broken-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const target = acmeRepo(path.join(root, 'target'), gh.env)
    const result = spawnSync(REAL_BUN, [installedCli(root, 'broken'), '--dir', target, '--dry-run'], {
      env: gh.env,
      encoding: 'utf8',
    })
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('init=blocked issue-triage missing (')
    expect(result.stderr).toContain('widget grammar exploded')
    expect(result.stderr).not.toContain('not found')
    expect(result.stdout).toBe('')
  })
})

describe('feature init never reaches the host gh', () => {
  it('reports gh failed and logs the exact argv the stub refused', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-nohost-'))
    const gh = hermeticGh(root, { argv: ['label', 'list', '--refuse-me'], body: 'size: M\n' })
    const target = acmeRepo(path.join(root, 'target'), gh.env)
    const result = spawnSync(REAL_BUN, [CLI, '--dir', target, '--dry-run'], { env: gh.env, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('labels unknown (gh failed)')
    expect(gh.calls()).toEqual([ARGV])
  })
})

describe('feature init landing via readLanding', () => {
  it('writes merge-on-green with no required_checks, read back as every check', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-landing-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const repo = acmeRepo(path.join(root, 'repo'), gh.env)
    const wt = path.join(root, 'wt')
    git(repo, gh.env, 'worktree', 'add', '-q', wt, '-b', 'feat/init')

    const apply = spawnSync(REAL_BUN, [CLI, '--dir', wt], { env: gh.env, encoding: 'utf8' })
    expect(apply.status).toBe(0)
    const stack = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    expect(stack).toMatch(/^landing:\n {2}mode: merge-on-green\n/m)
    expect(stack).not.toContain('required_checks')

    const driver =
      'const { readLanding } = await import(process.argv[1]); console.log(JSON.stringify(readLanding(process.argv[2])))'
    const landing = JSON.parse(execFileSync(REAL_BUN, ['-e', driver, WORKFLOW, wt], { env: gh.env, encoding: 'utf8' }))
    expect(landing).toEqual({ mode: 'merge-on-green', required_checks: [] })
  })
})

describe('lefthook snapshots under real bun', () => {
  const HOOKS = `
const [mod, file] = process.argv.slice(1)
const { hasSemctxGitHooks } = await import(mod)
const doc = Bun.YAML.parse(await Bun.file(file).text())
console.log(JSON.stringify({ doc, hooks: hasSemctxGitHooks(doc) }))
`
  function underBun(name: string) {
    const out = execFileSync(REAL_BUN, ['-e', HOOKS, CLI, path.join(FIXTURES, name, 'lefthook.yml')], {
      encoding: 'utf8',
    })
    return JSON.parse(out) as { doc: unknown; hooks: boolean }
  }

  it.each(FIXTURE_NAMES)('%s: the unit snapshots equal Bun.YAML.parse', (name) => {
    const snapshot = JSON.parse(readFileSync(path.join(FIXTURES, name, 'lefthook.parsed.json'), 'utf8'))
    expect(underBun(name).doc).toEqual(snapshot)
    const stack = execFileSync(
      REAL_BUN,
      [
        '-e',
        'console.log(JSON.stringify(Bun.YAML.parse(await Bun.file(process.argv[1]).text())))',
        path.join(FIXTURES, name, '.dev', 'stack.yml'),
      ],
      { encoding: 'utf8' },
    )
    expect(JSON.parse(stack)).toEqual(JSON.parse(readFileSync(path.join(FIXTURES, name, 'stack.parsed.json'), 'utf8')))
  })

  it('finds semctx in a pre-push command and not in a manual pr: group', () => {
    expect(underBun('hooks-ok').hooks).toBe(true)
    expect(underBun('pr-only').hooks).toBe(false)
  })
})

describe('feature init facts under real bun', () => {
  function dryRun(mutate: (dir: string) => void) {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-real-'))
    const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
    const target = path.join(root, 'target')
    stageFixture('kept', target)
    mutate(target)
    git(target, gh.env, 'init', '-q', '-b', 'main')
    git(target, gh.env, 'remote', 'add', 'origin', 'git@github.com:acme/app.git')
    return spawnSync(REAL_BUN, [CLI, '--dir', target, '--dry-run'], { env: gh.env, encoding: 'utf8' })
  }

  it('flags an existing required_checks list that hides other checks', () => {
    const result = dryRun((dir) => {
      const stack = path.join(dir, '.dev', 'stack.yml')
      writeFileSync(
        stack,
        readFileSync(stack, 'utf8').replace(
          '  mode: merge-on-green\n',
          '  mode: merge-on-green\n  required_checks: [widget-build]\n',
        ),
      )
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('landing kept (existing; required_checks hides other checks)')
  })

  it('reports an unparseable lefthook.yml instead of crashing', () => {
    const result = dryRun((dir) => writeFileSync(path.join(dir, 'lefthook.yml'), 'pre-push: [unclosed\n'))
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('semctx hooks unknown (lefthook.yml unreadable)')
  })
})
