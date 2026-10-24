import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { cleanEnv, runArgv } from './post-merge-hook-runner'

export type HookConfig = { argv: string[] } | { skip: string } | { error: string }

const SKIP = 'no release.post_merge — hook skipped'

/**
 * `release.post_merge` from a parsed `.dev/stack.yml`: an argv list whose first
 * element is a path inside the checkout, absent (skip), or refused. A string is
 * refused — it would need a shell — and so is a bare `argv[0]`, a PATH lookup.
 */
export function postMergeArgv(doc: unknown): HookConfig {
  const isMap = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  if (doc == null) return { skip: SKIP }
  if (!isMap(doc)) return { error: '.dev/stack.yml is not a map' }
  if (doc.release == null) return { skip: SKIP }
  if (!isMap(doc.release)) return { error: '.dev/stack.yml: release is not a map' }
  const hook = doc.release.post_merge
  if (hook == null) return { skip: SKIP }
  if (typeof hook === 'string') {
    return { error: 'release.post_merge is a string; it must be a YAML list (argv), run with no shell' }
  }
  if (!Array.isArray(hook) || !hook.length || !hook.every((arg) => typeof arg === 'string' && arg.length > 0)) {
    return { error: 'release.post_merge must be a non-empty list of strings (argv)' }
  }
  const argv = hook as string[]
  const head = argv[0] as string
  if (head.startsWith('/')) return { error: `argv[0] ${head} is absolute; name a script inside the repository` }
  if (!head.includes('/')) {
    return { error: `argv[0] ${head} would be a PATH lookup; name a script inside the repository (./scripts/…)` }
  }
  return { argv }
}

export type HookResult = {
  result: 'ok' | 'skipped' | 'failed'
  /** The `refs/remotes/origin/<base>` commit the argv was read from and ran on. */
  sha: string | null
  detail: string
  argv?: string[]
  code?: number | null
  output?: string
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: cleanEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function failedHook(sha: string | null, detail: string): HookResult {
  return { result: 'failed', sha, detail }
}

function runnerCwdFailure(repo: string): HookResult | undefined {
  // A worktree whose directory is gone (prunable) cannot hold the cwd.
  const trees = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ') && existsSync(line.slice('worktree '.length)))
    .map((line) => realpathSync(line.slice('worktree '.length)))
  const here = realpathSync(process.cwd())
  const home = trees.find((tree) => inside(here, tree))
  if (home) {
    return failedHook(null, `the runner's cwd ${here} is inside worktree ${home}; run it from outside the repository`)
  }
  return undefined
}

function remoteBaseSha(repo: string, base: string): string | HookResult {
  try {
    git(repo, ['check-ref-format', '--branch', base])
  } catch {
    return failedHook(null, `base ${JSON.stringify(base)} is not a branch name`)
  }
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`])
  } catch {
    return failedHook(null, `refs/remotes/origin/${base} is missing`)
  }
}

function postMergeConfig(
  repo: string,
  sha: string,
  parseYaml: (text: string) => unknown,
): HookResult | { argv: string[] } {
  // Only absence skips. A stack that exists but cannot be read (a missing object,
  // a gitlink, a blob a partial clone failed to fetch) fails: it is not "no hook".
  const listed = git(repo, ['ls-tree', '--format=%(objecttype)', sha, '--', '.dev/stack.yml'])
  if (listed === '') return { result: 'skipped', sha, detail: `no .dev/stack.yml at ${sha} — hook skipped` }
  if (listed !== 'blob') return failedHook(sha, `.dev/stack.yml at ${sha} is a ${listed}, not a file`)
  let text: string
  try {
    text = git(repo, ['cat-file', 'blob', `${sha}:.dev/stack.yml`])
  } catch (error) {
    return failedHook(sha, `.dev/stack.yml at ${sha} cannot be read: ${error instanceof Error ? error.message : error}`)
  }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    return failedHook(
      sha,
      `.dev/stack.yml at ${sha} is not valid YAML: ${error instanceof Error ? error.message : error}`,
    )
  }
  const config = postMergeArgv(doc)
  if ('skip' in config) return { result: 'skipped', sha, detail: config.skip }
  if ('error' in config) return failedHook(sha, config.error)
  return config
}

async function runInDetachedCheckout(
  repo: string,
  sha: string,
  argv: string[],
  timeoutMs: number,
  onStart: ((sha: string, argv: string[]) => Promise<void> | void) | undefined,
): Promise<HookResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'omp-post-merge-'))
  const checkout = join(scratch, 'checkout')
  try {
    // No hook of the repository fires on this checkout: it must stay the commit.
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', checkout, sha])
    const root = realpathSync(checkout)
    const [script, ...args] = argv
    if (!script) return failedHook(sha, `argv[0] ${script} does not exist at ${sha}`)
    let exe: string
    try {
      exe = realpathSync(join(root, script))
    } catch {
      return failedHook(sha, `argv[0] ${script} does not exist at ${sha}`)
    }
    if (!inside(exe, root) || exe === root) {
      return failedHook(sha, `argv[0] ${script} resolves to ${exe}, outside the checkout`)
    }
    await onStart?.(sha, argv)
    const run = await runArgv(exe, args, root, timeoutMs)
    const ran = { sha, argv, code: run.code, output: run.output }
    if (run.timedOut) return { ...ran, result: 'failed', detail: `hook timed out after ${timeoutMs} ms` }
    if (run.code !== 0) return { ...ran, result: 'failed', detail: `hook exited ${run.code}` }
    return { ...ran, result: 'ok', detail: 'hook succeeded' }
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', checkout])
    } catch {
      /* the prune below still unregisters it */
    }
    rmSync(scratch, { recursive: true, force: true })
    try {
      git(repo, ['worktree', 'prune'])
    } catch {
      /* best effort */
    }
  }
}

/**
 * Run `release.post_merge` once, per ADR-024 §1: read from
 * `refs/remotes/origin/<base>` (never the working tree), executed as argv with
 * no shell, in a temporary detached checkout of that commit that is removed
 * afterwards. `argv[0]` must resolve inside that checkout. The caller's cwd must
 * be outside every worktree of the repository, so the runner loads no `.env` or
 * `bunfig.toml` from the epic worktree. `onStart` runs just before the spawn.
 */
export async function runPostMergeHook(
  repo: string,
  base: string,
  {
    timeoutMs = 30 * 60_000,
    onStart,
    parseYaml = (text: string) => Bun.YAML.parse(text),
  }: {
    timeoutMs?: number
    onStart?: (sha: string, argv: string[]) => Promise<void> | void
    parseYaml?: (text: string) => unknown
  } = {},
): Promise<HookResult> {
  const cwdFailure = runnerCwdFailure(repo)
  if (cwdFailure) return cwdFailure
  const sha = remoteBaseSha(repo, base)
  if (typeof sha !== 'string') return sha
  const config = postMergeConfig(repo, sha, parseYaml)
  if ('result' in config) return config
  return runInDetachedCheckout(repo, sha, config.argv, timeoutMs, onStart)
}
