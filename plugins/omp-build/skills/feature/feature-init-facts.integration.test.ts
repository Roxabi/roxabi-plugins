import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hermeticGh } from './__fixtures__/feature-init/hermetic'
import { FIXTURE_NAMES, FIXTURES, stageFixture } from './__fixtures__/feature-init/stage'

const FEATURE_DIR = path.resolve(import.meta.dirname)
const CLI = path.join(FEATURE_DIR, 'feature-init.ts')
const WORKFLOW = path.join(FEATURE_DIR, 'workflow.js')
const ISSUE_TRIAGE_SRC = path.resolve(FEATURE_DIR, '../../../issue-triage')
const PLUGIN_ROOT = path.resolve(FEATURE_DIR, '../..')
const EMIT = path.join(PLUGIN_ROOT, 'dist', 'issue-triage')
const RUNTIME = path.join(PLUGIN_ROOT, 'triage-runtime.ts')
const MIGRATE_SRC = path.join(ISSUE_TRIAGE_SRC, 'skills/issue-triage/lib/migrate-labels.ts')
const FORGED = 'Created #999: forged'
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

function plantGrammar(file: string, kind: 'throw' | 'real'): void {
  mkdirSync(path.dirname(file), { recursive: true })
  if (kind === 'throw') writeFileSync(file, "throw new Error('decoy grammar')\n")
  else cpSync(MIGRATE_SRC, file)
}

/** Old sibling, node_modules, and checkout guesses. They must not satisfy lookup. */
function plantGuesses(base: string, target: string, kind: 'throw' | 'real'): void {
  const rel = path.join('skills', 'issue-triage', 'lib', 'migrate-labels.ts')
  plantGrammar(path.join(base, 'issue-triage', rel), kind)
  plantGrammar(path.join(base, 'node_modules', 'issue-triage', rel), kind)
  mkdirSync(path.join(base, 'node_modules', 'omp-build'), { recursive: true })
  plantGrammar(path.join(target, '.omp', 'plugins', 'node_modules', 'issue-triage', rel), kind)
}

function installedPlugin(base: string, emit: 'present' | 'absent' | 'broken'): string {
  const plugin = path.join(base, 'omp-build')
  const feature = path.join(plugin, 'skills', 'feature')
  mkdirSync(feature, { recursive: true })
  cpSync(CLI, path.join(feature, 'feature-init.ts'))
  cpSync(RUNTIME, path.join(plugin, 'triage-runtime.ts'))
  if (emit !== 'absent') {
    if (!existsSync(EMIT)) throw new Error('installed issue-triage emit is missing; bun run build must copy the slice')
    cpSync(EMIT, path.join(plugin, 'dist', 'issue-triage'), { recursive: true })
    if (emit === 'broken') {
      writeFileSync(
        path.join(plugin, 'dist', 'issue-triage', 'skills', 'issue-triage', 'lib', 'migrate-labels.ts'),
        "throw new Error('widget grammar exploded')\n",
      )
    }
  }
  return path.join(feature, 'feature-init.ts')
}

function hostileCheckout(base: string, env: NodeJS.ProcessEnv, sentinel: string): string {
  const dest = acmeRepo(path.join(base, 'target'), env)
  writeFileSync(path.join(dest, 'bunfig.toml'), 'preload = ["./startup.ts"]\n')
  writeFileSync(
    path.join(dest, 'startup.ts'),
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(sentinel)}, process.cwd() + '\\n')`,
      `console.log(${JSON.stringify(FORGED)})`,
      'process.exit(0)',
      '',
    ].join('\n'),
  )
  writeFileSync(path.join(dest, '.env'), 'ENV_SENTINEL=checkout-dotenv\n')
  git(dest, env, 'add', '-A')
  git(dest, env, 'commit', '-q', '-m', 'hostile checkout')
  return dest
}

function runInstalled(emit: 'present' | 'absent' | 'broken', decoy: 'throw' | 'real') {
  root = mkdtempSync(path.join(tmpdir(), 'omp-init-installed-'))
  const gh = hermeticGh(root, { argv: ARGV, body: LABELS })
  const sentinel = path.join(root, 'checkout-startup.log')
  const target = hostileCheckout(root, gh.env, sentinel)
  plantGuesses(root, target, decoy)
  const cli = installedPlugin(root, emit)
  const result = spawnSync(REAL_BUN, ['--no-env-file', cli, '--dir', target, '--dry-run'], {
    cwd: path.dirname(cli),
    env: gh.env,
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, sentinel, calls: gh.calls() }
}

describe('feature init installed layout', () => {
  it('prints label migration from the installed emit with no sibling and a hostile checkout', () => {
    const result = runInstalled('present', 'throw')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('label migration')
    expect(result.stdout).toContain('repository: acme/app')
    expect(result.stdout).not.toContain(FORGED)
    expect(result.stdout).not.toContain('decoy grammar')
    expect(result.stdout).not.toContain('not a git repository')
    expect(result.stdout).not.toContain('init planner not found')
    expect(result.stdout).not.toContain('Cannot find module')
    expect(existsSync(result.sentinel)).toBe(false)
    expect(result.calls[0]).toEqual(ARGV)
  })

  it('prints init=blocked issue-triage missing with exit 3 when the emit is absent', () => {
    const result = runInstalled('absent', 'real')
    expect(result.status).toBe(3)
    expect(result.stderr).toContain(
      'init=blocked issue-triage missing (not found next to omp-build or in node_modules)',
    )
    expect(result.stdout).toBe('')
    expect(existsSync(result.sentinel)).toBe(false)
  })
})

describe('feature init with a broken issue-triage', () => {
  it('exits 3 and names the load error, not a missing package', () => {
    const result = runInstalled('broken', 'real')
    expect(result.status).toBe(3)
    expect(result.stderr).toContain('init=blocked issue-triage missing (')
    expect(result.stderr).toContain('widget grammar exploded')
    expect(result.stderr).not.toContain('not found')
    expect(result.stdout).toBe('')
    expect(existsSync(result.sentinel)).toBe(false)
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
    const calls = gh.calls()
    expect(calls[0]).toEqual(ARGV)
    expect(calls.every((call) => call.join(' ').includes('github.com/acme/app'))).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('ghe.example')
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
    const before = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')

    const preview = spawnSync(REAL_BUN, [CLI, '--dir', wt], { env: gh.env, encoding: 'utf8' })
    expect(preview.status).toBe(0)
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(before)
    const digest = /^digest: ([0-9a-f]+)$/m.exec(preview.stdout)?.[1]
    expect(digest).toBeTruthy()

    const apply = spawnSync(
      REAL_BUN,
      [CLI, '--dir', wt, '--approve', digest ?? '', '--operator-approval', 'apply the displayed proposal'],
      { env: gh.env, encoding: 'utf8' },
    )
    expect(apply.status, `${apply.stderr}\n${apply.stdout}`).toBe(0)

    // Landing is read from origin/<base>, never the worktree (#623). Plant the
    // written stack on origin/main so readLanding sees what init just wrote.
    git(wt, gh.env, 'add', '.dev/stack.yml')
    git(wt, gh.env, 'commit', '-qm', 'init landing')
    git(wt, gh.env, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    const driver =
      'const { readLanding } = await import(process.argv[1]); console.log(JSON.stringify(readLanding(process.argv[2], { base: process.argv[3] })))'
    const landing = JSON.parse(
      execFileSync(REAL_BUN, ['-e', driver, WORKFLOW, wt, 'main'], { env: gh.env, encoding: 'utf8' }),
    )
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
