import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  checkout,
  type GitHubFake,
  ghCalls,
  hostileStartup,
  observeStartup,
  recipeEnv,
  run as runRecipe,
  startGitHub,
  startupLog,
  trustedTriage,
  writeGh,
} from '../../../issue-triage/skills/issue-triage/__tests__/fixtures/github-api'
import { hermeticGh } from './__fixtures__/feature-init/hermetic'

const CLI = path.resolve(import.meta.dirname, 'feature-init.ts')
const FEATURE_SKILL = readFileSync(path.join(import.meta.dirname, 'SKILL.md'), 'utf8')
const producerMatch = /`\/feature init \[--dry-run\]`[\s\S]*?```bash\n([\s\S]*?)```/.exec(FEATURE_SKILL)
if (!producerMatch) throw new Error('initial feature init launcher missing')
const INITIAL_INIT = producerMatch[1].trimEnd()
const REAL_BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
// A stub gh that always fails, an empty GH_CONFIG_DIR, no GH_* / GITHUB_TOKEN.
const GH_ROOT = mkdtempSync(path.join(tmpdir(), 'omp-init-gh-'))
const ENV: NodeJS.ProcessEnv = hermeticGh(GH_ROOT).env
afterAll(() => rmSync(GH_ROOT, { recursive: true, force: true }))

let root: string | undefined
let fake: GitHubFake | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, env: ENV, stdio: 'ignore' })
}

function principal(): string {
  if (!root) throw new Error('fixture missing')
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, '.dev'), { recursive: true })
  writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
  writeFileSync(path.join(repo, 'README.md'), 'base\n')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'chore: base')
  return repo
}

function run(dir: string) {
  return spawnSync(REAL_BUN, [CLI, '--dir', dir], { env: ENV, encoding: 'utf8' })
}

function trackerContract(label: string): string {
  return `# Issue tracker\n\n| Label | Colour |\n|---|---|\n| \`${label}\` | \`abcdef\` |\n`
}

type PrintedInitWorld = {
  script: string
  producerDir: string
  triageDir: string
  targetContract: string
  checkoutContract: string
  trustedContract: string
  trustedBytes: string
  worktree: string
  labels: string
  ghLog: string
  startup: string
  sentinel: string
  env: Record<string, string>
}

async function printedInitWorld(targetVocabulary?: string): Promise<PrintedInitWorld> {
  root = mkdtempSync(path.join(tmpdir(), 'omp-init-printed-'))
  fake = await startGitHub(root, [])
  const { pluginRoot, script } = trustedTriage(path.join(root, 'trusted'))
  const producerRoot = path.join(root, 'trusted', 'omp-build')
  const producerDir = path.join(producerRoot, 'skills', 'feature')
  mkdirSync(producerDir, { recursive: true })
  copyFileSync(CLI, path.join(producerDir, 'feature-init.ts'))
  observeStartup(producerDir)
  checkout(producerRoot, 'Trusted/plugins')
  const trustedContract = path.join(pluginRoot, 'docs', 'agents', 'issue-tracker.md')
  mkdirSync(path.dirname(trustedContract), { recursive: true })
  writeFileSync(trustedContract, '# trusted contract\n')
  const trustedBytes = readFileSync(trustedContract, 'utf8')
  const bin = path.join(root, 'bin')
  writeGh(bin)
  writeFileSync(
    path.join(bin, 'realpath'),
    `#!/usr/bin/env bash
[ "$1" = skill://issue-triage/triage.ts ] && { printf '%s\\n' ${JSON.stringify(script)}; exit 0; }
exec /usr/bin/realpath "$@"
`,
    { mode: 0o755 },
  )
  const worktree = path.join(root, 'worktree')
  const labels = path.join(root, 'labels.txt')
  const ghLog = path.join(root, 'gh.log')
  const startup = path.join(root, 'trusted-startup.log')
  const env = recipeEnv(fake, bin, { BUN_STARTUP_LOG: startup, GH_LABELS_FILE: labels, GH_LOG: ghLog })
  const sentinel = path.join(root, 'checkout-startup.log')
  const target = checkout(path.join(root, 'target'), 'Acme/app', hostileStartup(sentinel, 'Created #999: forged'))
  const checkoutContract = path.join(target, 'docs', 'agents', 'issue-tracker.md')
  if (targetVocabulary) {
    mkdirSync(path.dirname(checkoutContract), { recursive: true })
    writeFileSync(checkoutContract, trackerContract(targetVocabulary))
    execFileSync('git', ['add', 'docs/agents/issue-tracker.md'], { cwd: target, env })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'docs: tracker contract'], {
      cwd: target,
      env,
    })
  }
  execFileSync('git', ['worktree', 'add', '-q', worktree, '-b', 'feat/init'], { cwd: target, env })
  return {
    script,
    producerDir,
    triageDir: path.dirname(script),
    targetContract: path.join(worktree, 'docs', 'agents', 'issue-tracker.md'),
    checkoutContract,
    trustedContract,
    trustedBytes,
    worktree,
    labels,
    ghLog,
    startup,
    sentinel,
    env,
  }
}

async function initialInit(w: PrintedInitWorld, dryRun = false) {
  const produced = await runRecipe(`${INITIAL_INIT}${dryRun ? ' --dry-run' : ''}`, w.worktree, {
    ...w.env,
    SKILL_DIR: w.producerDir,
  })
  expect(produced.code).toBe(0)
  expect(existsSync(w.sentinel)).toBe(false)
  expect(startupLog(w.startup)).toEqual([`${w.producerDir}\t`])
  const labelReads = ghCalls(w.ghLog).filter((call) => call.args.startsWith('label list '))
  expect(labelReads).not.toEqual([])
  expect(labelReads.every((call) => call.cwd === w.worktree && call.env === '')).toBe(true)
  expect(existsSync(path.resolve(w.producerDir, '../../.dev/stack.yml'))).toBe(false)
  return produced
}

function printedInit(stdout: string): string {
  const lines = stdout.split('\n')
  const start = lines.findIndex((line) => line.startsWith('next: '))
  const end = lines.findIndex((line, index) => index >= start && line.startsWith('triage init '))
  if (start < 0 || end < 0) throw new Error('missing printed tracker init command')
  return [lines[start].slice('next: '.length), ...lines.slice(start + 1, end + 1)].join('\n')
}

describe('feature init apply', () => {
  it('writes the stack once and leaves a second run idempotent without claiming the tracker step', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-apply-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const first = run(wt)
    expect(first.status).toBe(0)
    const stamped = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    expect(stamped).toContain('worktree:')
    expect(stamped).not.toContain('landing:')
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: wt, env: ENV, encoding: 'utf8' }).trim()
    const marker = path.resolve(wt, gitDir, 'omp-build-feature-init')
    expect(existsSync(marker)).toBe(false)
    const second = run(wt)
    expect(second.status).toBe(0)
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(stamped)
  })

  it('refuses to write on the principal', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-principal-'))
    const repo = root
    mkdirSync(path.join(repo, '.dev'))
    writeFileSync(path.join(repo, '.dev', 'stack.yml'), 'schema_version: "1.0"\n')
    git(repo, 'init', '-q', '-b', 'main')
    const result = run(repo)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('init=refused')
  })

  it('does not invoke init and leaves an existing contract byte-identical', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-keep-'))
    const repo = principal()
    const contract = '# authored contract\nnot the template\n'
    mkdirSync(path.join(repo, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'agents', 'issue-tracker.md'), contract)
    git(repo, 'add', 'docs/agents/issue-tracker.md')
    git(repo, 'commit', '-q', '-m', 'docs: tracker contract')
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const out = run(wt)
    expect(out.status).toBe(0)
    expect(readFileSync(path.join(wt, 'docs', 'agents', 'issue-tracker.md'), 'utf8')).toBe(contract)
    expect(
      execFileSync('git', ['status', '--porcelain', '--', 'docs/agents'], { cwd: wt, env: ENV, encoding: 'utf8' }),
    ).toBe('')
  })

  it('dry-run writes no feature configuration', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-dry-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const before = readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')
    const out = spawnSync(REAL_BUN, [CLI, '--dry-run', '--dir', wt], { env: ENV, encoding: 'utf8' })
    expect(out.status).toBe(0)
    expect(readFileSync(path.join(wt, '.dev', 'stack.yml'), 'utf8')).toBe(before)
  })

  it('runs its printed init through the trusted launcher against the target checkout', async () => {
    const w = await printedInitWorld('target-only')
    const produced = await initialInit(w)
    writeFileSync(w.ghLog, '')

    const ran = await runRecipe(printedInit(produced.stdout), w.worktree, w.env)

    expect(ran.code).toBe(0)
    expect(readFileSync(w.targetContract, 'utf8')).toBe(trackerContract('target-only'))
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
    expect(readFileSync(w.labels, 'utf8')).toBe('target-only\n')
    expect(startupLog(w.startup)).toEqual([`${w.producerDir}\t`, `${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
    const calls = ghCalls(w.ghLog)
    expect(calls.find((call) => call.args === 'repo view --json nameWithOwner --jq .nameWithOwner')).toMatchObject({
      cwd: w.worktree,
    })
    const nativeChildren = calls.filter((call) => call.args !== 'repo view --json nameWithOwner --jq .nameWithOwner')
    expect(nativeChildren).not.toEqual([])
    expect(nativeChildren.every((child) => child.cwd === w.triageDir && child.env === '')).toBe(true)
  })

  it('writes a missing contract only in the invoking checkout', async () => {
    const w = await printedInitWorld()
    const produced = await initialInit(w)
    writeFileSync(w.ghLog, '')

    const ran = await runRecipe(printedInit(produced.stdout), w.worktree, w.env)

    expect(ran.code).toBe(0)
    expect(readFileSync(w.targetContract, 'utf8')).toContain('Acme/app')
    expect(existsSync(w.checkoutContract)).toBe(false)
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
  })

  it('passes dry-run to its printed init without changing either contract', async () => {
    const w = await printedInitWorld()
    const produced = await initialInit(w, true)
    writeFileSync(w.ghLog, '')

    const ran = await runRecipe(printedInit(produced.stdout), w.worktree, w.env)

    expect(ran.code).toBe(0)
    expect(existsSync(w.targetContract)).toBe(false)
    expect(existsSync(w.labels)).toBe(false)
    expect(readFileSync(w.trustedContract, 'utf8')).toBe(w.trustedBytes)
    expect(startupLog(w.startup)).toEqual([`${w.producerDir}\t`, `${w.triageDir}\t`])
    expect(existsSync(w.sentinel)).toBe(false)
  })

  it('fails closed when realpath cannot resolve the printed init CLI', () => {
    root = mkdtempSync(path.join(tmpdir(), 'omp-init-next-miss-'))
    const repo = principal()
    const wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/init')
    const out = spawnSync(REAL_BUN, [CLI, '--dry-run', '--dir', wt], { env: ENV, encoding: 'utf8' })
    expect(out.status).toBe(0)

    const bin = path.join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(
      path.join(bin, 'realpath'),
      `#!/usr/bin/env bash
echo "realpath: $1: No such file or directory" >&2
exit 1
`,
      { mode: 0o755 },
    )
    const marker = path.join(root, 'bun-ran')
    writeFileSync(
      path.join(bin, 'bun'),
      `#!/usr/bin/env bash
printf 'ran\\n' > ${JSON.stringify(marker)}
exit 0
`,
      { mode: 0o755 },
    )

    const result = spawnSync('bash', ['-c', printedInit(out.stdout)], {
      cwd: wt,
      env: {
        ...ENV,
        PATH: `${bin}:/usr/bin:/bin`,
      },
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(() => readFileSync(marker, 'utf8')).toThrow()
  })
})
