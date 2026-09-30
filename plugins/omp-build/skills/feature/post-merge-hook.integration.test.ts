import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HookResult } from './epic-close'

// `.dev/stack.yml` is parsed with Bun.YAML, which the vitest worker does not
// have: every case runs the real runner under bun, as the driver does.
const MODULE = join(import.meta.dirname, 'epic-close.ts')

const DRIVER = `
const [mod, repo, base, timeoutMs] = process.argv.slice(1)
const { runPostMergeHook } = await import(mod)
const started = []
const options = { onStart: (sha, argv) => { started.push({ sha, argv }) } }
if (timeoutMs) options.timeoutMs = Number(timeoutMs)
const result = await runPostMergeHook(repo, base, options)
console.log(JSON.stringify({ result, started }))
`

/**
 * Hermetic: no GIT_* from the caller (a git hook running the suite sets
 * GIT_DIR), no user or system git config.
 */
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Writes the hook's cwd, the checkout's `stamp.txt` and each argument, one per line, to `$1`. */
const HOOK = `#!/bin/sh
out="$1"
shift
{
  pwd -P
  cat stamp.txt
  for arg in "$@"; do printf 'arg=%s\\n' "$arg"; done
} > "$out"
`

type Entry = string | { exec: string } | { link: string }

function write(root: string, files: Record<string, Entry>): void {
  for (const [path, entry] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    rmSync(file, { force: true })
    if (typeof entry === 'string') writeFileSync(file, entry)
    else if ('exec' in entry) {
      writeFileSync(file, entry.exec)
      chmodSync(file, 0o755)
    } else symlinkSync(entry.link, file)
  }
}

/** `.dev/stack.yml` with `release.post_merge` set to `postMerge` (a list or a scalar), or absent. */
function stackYml(postMerge?: string[] | string): string {
  const lines = ['release:', '  model: trunk']
  if (Array.isArray(postMerge)) lines.push('  post_merge:', ...postMerge.map((arg) => `    - ${JSON.stringify(arg)}`))
  else if (postMerge !== undefined) lines.push(`  post_merge: ${JSON.stringify(postMerge)}`)
  return `${lines.join('\n')}\n`
}

let scratch = ''
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'omp-hook-it-')))
})
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Where a hook that ran writes its evidence. */
const proofPath = () => join(scratch, 'proof.txt')

/**
 * A bare `origin` whose `main` carries `files`, and a clone of it, so the clone
 * has `refs/remotes/origin/main`. `outside` is a directory in no worktree.
 */
function seed(files: Record<string, Entry>): { clone: string; outside: string; originSha: string } {
  const origin = join(scratch, 'origin.git')
  const work = join(scratch, 'seed')
  const clone = join(scratch, 'clone')
  const outside = join(scratch, 'outside')
  mkdirSync(outside)
  git(scratch, 'init', '--quiet', '--bare', '-b', 'main', origin)
  git(scratch, 'init', '--quiet', '-b', 'main', work)
  write(work, { 'stamp.txt': 'origin\n', ...files })
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'seed')
  git(work, 'push', '--quiet', origin, 'main')
  git(scratch, 'clone', '--quiet', origin, clone)
  return { clone, outside, originSha: git(clone, 'rev-parse', 'refs/remotes/origin/main') }
}

function runHook(
  repo: string,
  cwd: string,
  { base = 'main', timeoutMs, env = ENV }: { base?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): { result: HookResult; started: { sha: string; argv: string[] }[] } {
  const args = ['-e', DRIVER, MODULE, repo, base]
  if (timeoutMs !== undefined) args.push(String(timeoutMs))
  return JSON.parse(execFileSync('bun', args, { cwd, env, encoding: 'utf8' }))
}

function worktrees(repo: string): string[] {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

/** Whether process `pid` has exited, allowing up to 2 s for an orphan to be reaped. */
function exited(pid: number): boolean {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}

describe('runPostMergeHook', () => {
  it('runs the argv with no shell in a temporary checkout of origin/<base>, then removes it', () => {
    const argv = ['./scripts/post-merge.sh', proofPath(), 'two words', '$HOME;touch pwned']
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(argv),
    })

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'ok', sha: originSha, argv, code: 0 })
    expect(started).toEqual([{ sha: originSha, argv }])
    const [cwd, stamp, ...args] = readFileSync(proofPath(), 'utf8').trimEnd().split('\n')
    expect(stamp).toBe('origin')
    expect(args).toEqual(['arg=two words', 'arg=$HOME;touch pwned'])
    expect(cwd).toMatch(/\/checkout$/)
    expect(cwd?.startsWith(`${clone}/`)).toBe(false)
    expect(cwd?.startsWith(`${outside}/`)).toBe(false)
    expect(existsSync(cwd as string)).toBe(false)
    expect(existsSync(dirname(cwd as string))).toBe(false)
    expect(existsSync(join(outside, 'pwned'))).toBe(false)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('reads the hook from origin/<base>, not from HEAD or the working tree', () => {
    const local = join(scratch, 'local.txt')
    const edited = join(scratch, 'edited.txt')
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })
    write(clone, { 'stamp.txt': 'local\n', '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', local]) })
    git(clone, 'commit', '--quiet', '-am', 'unpushed')
    write(clone, { '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', edited]) })
    expect(git(clone, 'rev-parse', 'HEAD')).not.toBe(originSha)

    const { result } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'ok', sha: originSha })
    expect(readFileSync(proofPath(), 'utf8').split('\n')[1]).toBe('origin')
    expect(existsSync(local)).toBe(false)
    expect(existsSync(edited)).toBe(false)
  })

  it('fires no git hook of the repository while creating the temporary checkout', () => {
    const fired = join(scratch, 'post-checkout-fired')
    const { clone, outside } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })
    write(join(clone, '.git', 'hooks'), { 'post-checkout': { exec: `#!/bin/sh\ntouch ${JSON.stringify(fired)}\n` } })

    const { result } = runHook(clone, outside)

    expect(result.result).toBe('ok')
    expect(existsSync(fired)).toBe(false)
  })

  it('ignores a GIT_DIR inherited from its caller', () => {
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const { result } = runHook(clone, outside, { env: { ...ENV, GIT_DIR: join(scratch, 'origin.git') } })

    expect(result).toMatchObject({ result: 'ok', sha: originSha })
    expect(readFileSync(proofPath(), 'utf8').split('\n')[1]).toBe('origin')
    expect(worktrees(clone)).toEqual([clone])
  })

  it.each<{ name: string; why: RegExp; files: (proof: string) => Record<string, Entry> }>([
    {
      name: 'a string value',
      why: /is a string/,
      files: (proof) => ({
        'scripts/post-merge.sh': { exec: HOOK },
        '.dev/stack.yml': stackYml(`./scripts/post-merge.sh ${proof}`),
      }),
    },
    {
      name: 'a PATH-lookup argv[0]',
      why: /PATH lookup/,
      files: (proof) => ({
        'scripts/post-merge.sh': { exec: HOOK },
        '.dev/stack.yml': stackYml(['sh', './scripts/post-merge.sh', proof]),
      }),
    },
    {
      name: 'an absolute argv[0]',
      why: /is absolute/,
      files: (proof) => ({
        'scripts/post-merge.sh': { exec: HOOK },
        '.dev/stack.yml': stackYml(['/bin/sh', './scripts/post-merge.sh', proof]),
      }),
    },
    {
      name: 'a symlink escaping to a system binary',
      why: /outside the checkout/,
      files: (proof) => ({
        'scripts/post-merge.sh': { exec: HOOK },
        'scripts/run': { link: '/bin/sh' },
        '.dev/stack.yml': stackYml(['./scripts/run', './scripts/post-merge.sh', proof]),
      }),
    },
    {
      name: 'a symlink escaping to a script outside the checkout',
      why: /outside the checkout/,
      files: (proof) => {
        write(scratch, { 'elsewhere.sh': { exec: HOOK } })
        return {
          'scripts/run': { link: join(scratch, 'elsewhere.sh') },
          '.dev/stack.yml': stackYml(['./scripts/run', proof]),
        }
      },
    },
    {
      name: 'an argv[0] missing from the commit',
      why: /does not exist/,
      files: (proof) => ({ '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proof]) }),
    },
    {
      name: 'a stack.yml that is not YAML',
      why: /not valid YAML/,
      files: () => ({ 'scripts/post-merge.sh': { exec: HOOK }, '.dev/stack.yml': 'release: [unclosed\n' }),
    },
  ])('fails on $name without running anything', ({ why, files }) => {
    const { clone, outside } = seed(files(proofPath()))

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'failed', detail: expect.stringMatching(why) })
    expect(started).toEqual([])
    expect(existsSync(proofPath())).toBe(false)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('propagates a failing hook with its exit code and output, and still removes the checkout', () => {
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: '#!/bin/sh\necho boom >&2\nexit 3\n' },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh']),
    })

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'failed', sha: originSha, code: 3, output: expect.stringContaining('boom') })
    expect(started).toHaveLength(1)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('on timeout, kills the hook and its children and returns without waiting for them', () => {
    // `sleep` is a grandchild of the runner: signalling only the hook would leave it holding the output.
    const { clone, outside } = seed({
      'scripts/post-merge.sh': { exec: '#!/bin/sh\nsleep 20 &\necho $! > "$1"\nwait\n' },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const began = performance.now()
    const { result, started } = runHook(clone, outside, { timeoutMs: 300 })
    const elapsed = performance.now() - began

    expect(result).toMatchObject({ result: 'failed', code: null, detail: expect.stringMatching(/timed out/) })
    expect(elapsed).toBeLessThan(4000)
    expect(started).toHaveLength(1)
    expect(exited(Number(readFileSync(proofPath(), 'utf8')))).toBe(true)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('escalates to SIGKILL when the hook ignores SIGTERM', () => {
    const { clone, outside } = seed({
      'scripts/post-merge.sh': { exec: '#!/bin/sh\ntrap \'\' TERM\necho $$ > "$1"\nwhile :; do sleep 0.1; done\n' },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const began = performance.now()
    const { result } = runHook(clone, outside, { timeoutMs: 300 })
    const elapsed = performance.now() - began

    expect(result).toMatchObject({ result: 'failed', detail: expect.stringMatching(/timed out/) })
    expect(elapsed).toBeLessThan(8000)
    expect(exited(Number(readFileSync(proofPath(), 'utf8')))).toBe(true)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('returns when the hook exits, even if a background child still holds its output', () => {
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: '#!/bin/sh\nsleep 20 &\necho $! > "$1"\necho done\n' },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const began = performance.now()
    const { result } = runHook(clone, outside)
    const elapsed = performance.now() - began
    const orphan = Number(readFileSync(proofPath(), 'utf8'))
    // Nothing the hook started outlives it: the group is signalled once the hook exits.
    const gone = exited(orphan)
    try {
      process.kill(orphan, 'SIGKILL')
    } catch {
      /* already gone */
    }
    expect(gone).toBe(true)

    expect(result).toMatchObject({ result: 'ok', sha: originSha, code: 0, output: expect.stringContaining('done') })
    expect(elapsed).toBeLessThan(4000)
    expect(worktrees(clone)).toEqual([clone])
  })

  it('kills a background child that ignores SIGTERM once the hook exits', () => {
    const stubborn = `sh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 0.1; done' sh "$1" &`
    const { clone, outside } = seed({
      'scripts/post-merge.sh': { exec: `#!/bin/sh\n${stubborn}\nsleep 0.3\necho done\n` },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const { result } = runHook(clone, outside)
    const orphan = Number(readFileSync(proofPath(), 'utf8'))
    const gone = exited(orphan)
    try {
      process.kill(orphan, 'SIGKILL')
    } catch {
      /* already gone */
    }

    expect(gone).toBe(true)
    expect(result).toMatchObject({ result: 'ok', code: 0 })
    expect(worktrees(clone)).toEqual([clone])
  })

  it('ignores a registered worktree whose directory is gone', () => {
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })
    const gone = join(scratch, 'gone')
    git(clone, 'worktree', 'add', '--quiet', '--detach', gone)
    rmSync(gone, { recursive: true, force: true })
    expect(git(clone, 'worktree', 'list', '--porcelain')).toContain('prunable')

    const { result } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'ok', sha: originSha })
    expect(readFileSync(proofPath(), 'utf8').split('\n')[1]).toBe('origin')
  })

  it.each<[string, Record<string, Entry>]>([
    ['release.post_merge is absent', { '.dev/stack.yml': stackYml() }],
    ['there is no .dev/stack.yml', {}],
  ])('skips when %s, and says which commit it read', (_name, files) => {
    const { clone, outside, originSha } = seed(files)

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'skipped', sha: originSha })
    expect(started).toEqual([])
    expect(worktrees(clone)).toEqual([clone])
  })

  it('fails, not skips, when the stack exists but its object cannot be read', () => {
    const { clone, outside, originSha } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })
    const blob = git(clone, 'rev-parse', `${originSha}:.dev/stack.yml`)
    git(clone, 'repack', '-a', '-d', '-q')
    const packs = join(clone, '.git', 'objects', 'pack')
    // Unpack everything but that blob, so the tree still names an object the repository lacks.
    for (const pack of readdirSync(packs).filter((name) => name.endsWith('.pack'))) {
      const data = readFileSync(join(packs, pack))
      rmSync(join(packs, pack))
      rmSync(join(packs, pack.replace(/\.pack$/, '.idx')))
      execFileSync('git', ['unpack-objects', '-q'], { cwd: clone, env: ENV, input: data })
    }
    rmSync(join(clone, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'failed', sha: originSha })
    expect(started).toEqual([])
  })

  it('fails when .dev/stack.yml is a gitlink, not a file', () => {
    const { clone, outside } = seed({})
    git(clone, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},.dev/stack.yml`)
    git(clone, 'commit', '--quiet', '-m', 'gitlink')
    git(clone, 'push', '--quiet', 'origin', 'HEAD:main')
    git(clone, 'fetch', '--quiet', 'origin')

    const { result, started } = runHook(clone, outside)

    expect(result).toMatchObject({ result: 'failed' })
    expect(started).toEqual([])
  })

  it('fails when refs/remotes/origin/<base> is missing', () => {
    const { clone, outside } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })

    const { result, started } = runHook(clone, outside, { base: 'staging' })

    expect(result).toMatchObject({ result: 'failed', sha: null })
    expect(started).toEqual([])
    expect(existsSync(proofPath())).toBe(false)
  })

  it.each<[string, (clone: string) => string]>([
    ['the clone', (clone) => join(clone, 'scripts')],
    [
      'a linked worktree of it',
      (clone) => {
        const epic = join(scratch, 'epic')
        git(clone, 'worktree', 'add', '--quiet', '--detach', epic)
        return join(epic, 'scripts')
      },
    ],
  ])('fails when its cwd is inside %s', (_name, cwdOf) => {
    const { clone } = seed({
      'scripts/post-merge.sh': { exec: HOOK },
      '.dev/stack.yml': stackYml(['./scripts/post-merge.sh', proofPath()]),
    })
    const cwd = cwdOf(clone)
    const before = worktrees(clone)

    const { result, started } = runHook(clone, cwd)

    expect(result).toMatchObject({ result: 'failed', sha: null })
    expect(started).toEqual([])
    expect(existsSync(proofPath())).toBe(false)
    expect(worktrees(clone)).toEqual(before)
  })
})
