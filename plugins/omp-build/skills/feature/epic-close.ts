import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const GIT_SHA = /^[0-9a-f]{40}$/

/** One claiming landed PR; several records may belong to the same child. */
export type MergedChild = {
  number: number
  /** First parent of the merge commit. */
  baseSha: string | null
  mergeSha: string | null
  mergedAt: string | null
}

export type ChildDiff = { number: number; firstParent: string; merge: string }

/**
 * Ordered first-parent diffs of every claiming landed PR, plus the SHA-256 of
 * those fixed-width pairs. Sort by merge time, ticket, merge SHA, then parent SHA.
 * A later unusable SHA or date refuses the set; nothing is dropped. The
 * coverage token is an identity, never a Git argument, and has no decoder.
 */
export function epicCoverage(children: MergedChild[]): { diffs: ChildDiff[]; coverage: string } | { error: string } {
  if (!children.length) return { error: 'no merged children' }
  const validated: { number: number; firstParent: string; merge: string; at: number }[] = []
  for (const child of children) {
    if (!Number.isInteger(child.number) || child.number <= 0) return { error: 'claimed child has no ticket number' }
    if (!child.baseSha || !GIT_SHA.test(child.baseSha)) return { error: `#${child.number} has no merge base` }
    if (!child.mergeSha || !GIT_SHA.test(child.mergeSha)) return { error: `#${child.number} has no merge commit` }
    const at = Date.parse(child.mergedAt ?? '')
    if (!Number.isFinite(at)) return { error: `#${child.number} has no merge time` }
    validated.push({ number: child.number, firstParent: child.baseSha, merge: child.mergeSha, at })
  }
  const ordered = validated.sort((a, b) => {
    const order = a.at - b.at || a.number - b.number
    if (order) return order
    if (a.merge !== b.merge) return a.merge < b.merge ? -1 : 1
    return a.firstParent === b.firstParent ? 0 : a.firstParent < b.firstParent ? -1 : 1
  })
  const diffs = ordered.map(({ number, firstParent, merge }) => ({ number, firstParent, merge }))
  const coverage = createHash('sha256')
    .update(diffs.map((diff) => diff.firstParent + diff.merge).join(''))
    .digest('hex')
  return { diffs, coverage }
}

// ── Post-merge hook (ADR-024 §1) ─────────────────────────────────────────────

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

/** Hook vars that redirect git, stripped before any git or hook child runs. */
const GIT_REDIRECTS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_INDEX_FILE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
]

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of GIT_REDIRECTS) delete env[key]
  return env
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

/**
 * Spawn `exe` in its own process group, no shell. The run ends when the hook
 * exits: a grandchild left holding its output does not keep it open, and on the
 * deadline the whole group is signalled, not just the direct child.
 */
function runArgv(
  exe: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; output: string; timedOut: boolean }>()
  const child = spawn(exe, args, {
    cwd,
    env: cleanEnv(),
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let timedOut = false
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-8000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  const signal = (name: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, name)
    } catch {
      /* the group is already gone */
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    signal('SIGTERM')
    setTimeout(() => signal('SIGKILL'), 5000).unref()
  }, timeoutMs)
  let settled = false
  let grace: NodeJS.Timeout | undefined
  const groupAlive = () => {
    try {
      if (!child.pid) return false
      process.kill(-child.pid, 0)
      return true
    } catch {
      return false
    }
  }
  const settle = (code: number | null, extra = '') => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    clearTimeout(grace)
    child.stdout?.destroy()
    child.stderr?.destroy()
    const result = { code, output: `${output}${extra}`, timedOut }
    // The hook is done: nothing it started outlives it in a checkout about to be
    // removed. SIGTERM the group, then SIGKILL whatever ignores it for 2 s.
    signal('SIGTERM')
    let waited = 0
    const reap = () => {
      if (!groupAlive()) return resolve(result)
      if (waited >= 2000) {
        signal('SIGKILL')
        return resolve(result)
      }
      waited += 50
      setTimeout(reap, 50)
    }
    reap()
  }
  child.on('error', (error) => settle(null, error.message))
  // `close` follows `exit` once the pipes drain; a grandchild holding them open
  // gets a short grace, then the pipes are dropped.
  child.on('close', (code) => settle(code))
  child.on('exit', (code) => {
    grace = setTimeout(() => settle(code), 250)
  })
  return promise
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
  const failed = (sha: string | null, detail: string): HookResult => ({ result: 'failed', sha, detail })
  // A worktree whose directory is gone (prunable) cannot hold the cwd.
  const trees = git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree ') && existsSync(line.slice('worktree '.length)))
    .map((line) => realpathSync(line.slice('worktree '.length)))
  const here = realpathSync(process.cwd())
  const home = trees.find((tree) => inside(here, tree))
  if (home)
    return failed(null, `the runner's cwd ${here} is inside worktree ${home}; run it from outside the repository`)

  try {
    git(repo, ['check-ref-format', '--branch', base])
  } catch {
    return failed(null, `base ${JSON.stringify(base)} is not a branch name`)
  }
  let sha: string
  try {
    sha = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`])
  } catch {
    return failed(null, `refs/remotes/origin/${base} is missing`)
  }

  // Only absence skips. A stack that exists but cannot be read (a missing object,
  // a gitlink, a blob a partial clone failed to fetch) fails: it is not "no hook".
  const listed = git(repo, ['ls-tree', '--format=%(objecttype)', sha, '--', '.dev/stack.yml'])
  if (listed === '') return { result: 'skipped', sha, detail: `no .dev/stack.yml at ${sha} — hook skipped` }
  if (listed !== 'blob') return failed(sha, `.dev/stack.yml at ${sha} is a ${listed}, not a file`)
  let text: string
  try {
    text = git(repo, ['cat-file', 'blob', `${sha}:.dev/stack.yml`])
  } catch (error) {
    return failed(sha, `.dev/stack.yml at ${sha} cannot be read: ${error instanceof Error ? error.message : error}`)
  }
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    return failed(sha, `.dev/stack.yml at ${sha} is not valid YAML: ${error instanceof Error ? error.message : error}`)
  }
  const config = postMergeArgv(doc)
  if ('skip' in config) return { result: 'skipped', sha, detail: config.skip }
  if ('error' in config) return failed(sha, config.error)

  const scratch = mkdtempSync(join(tmpdir(), 'omp-post-merge-'))
  const checkout = join(scratch, 'checkout')
  try {
    // No hook of the repository fires on this checkout: it must stay the commit.
    git(repo, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', checkout, sha])
    const root = realpathSync(checkout)
    let exe: string
    try {
      exe = realpathSync(join(root, config.argv[0] as string))
    } catch {
      return failed(sha, `argv[0] ${config.argv[0]} does not exist at ${sha}`)
    }
    if (!inside(exe, root) || exe === root) {
      return failed(sha, `argv[0] ${config.argv[0]} resolves to ${exe}, outside the checkout`)
    }
    await onStart?.(sha, config.argv)
    const run = await runArgv(exe, config.argv.slice(1), root, timeoutMs)
    const ran = { sha, argv: config.argv, code: run.code, output: run.output }
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
