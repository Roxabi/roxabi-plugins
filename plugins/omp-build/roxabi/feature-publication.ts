import type { Gh } from '../adapters/github/types.ts'
import type { GitRunner } from './workflow-checkout.ts'

const FULL_SHA = /^[0-9a-f]{40}$/
const GITHUB_REMOTE =
  /^(?:(?:https:\/\/|ssh:\/\/git@)([A-Za-z0-9.-]+)\/|git@([A-Za-z0-9.-]+):)([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)$/

/** Read all effective push URLs (including Git's URL rewriting), never just the first. */
export async function featureOrigin(git: GitRunner, gh: Gh, cwd: string, repository: string): Promise<string> {
  const [fetch, push] = await Promise.all([
    git(cwd, ['remote', 'get-url', '--all', 'origin']),
    git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']),
  ])
  const fetchUrl = fetch.stdout.trim()
  const pushUrl = push.stdout.trim()
  if (pushUrl.includes('\n')) throw new Error('multiple-origin-push-urls')
  if (fetch.code !== 0 || push.code !== 0) throw new Error('origin-unreadable')
  const host = (process.env.GH_HOST || 'github.com').toLowerCase()
  for (const url of new Set([fetchUrl, pushUrl])) {
    const match = GITHUB_REMOTE.exec(url)
    if (match === null) throw new Error('origin-unreadable')
    if ((match[1] ?? match[2])?.toLowerCase() !== host || match[3]?.replace(/\.git$/, '') !== repository)
      throw new Error('origin-repository-mismatch')
  }
  const locator = `https://${host}/${repository}`
  const resolved = JSON.parse(await gh(cwd, ['repo', 'view', locator, '--json', 'nameWithOwner,url']))
  if (resolved?.nameWithOwner !== repository || resolved.url !== locator) throw new Error('origin-repository-mismatch')
  return pushUrl
}

/** Distinguish verified absence from a failed or malformed remote observation. */
export async function readFeatureRemote(
  git: GitRunner,
  cwd: string,
  url: string,
  branch: string,
): Promise<string | null> {
  const ref = `refs/heads/${branch}`
  const observed = await git(cwd, ['ls-remote', '--refs', url, ref])
  const raw = observed.stdout.trim()
  if (observed.code !== 0) throw new Error('remote-ref-unreadable')
  if (raw === '') return null
  const fields = raw.split(/\s+/)
  if (fields.length !== 2 || !FULL_SHA.test(fields[0] ?? '') || fields[1] !== ref)
    throw new Error('remote-ref-unreadable')
  return fields[0] ?? null
}

export async function pushFeatureTip(input: {
  git: GitRunner
  cwd: string
  origin: string
  branch: string
  base: string
  tip: string
  from: string | null
  beforePush: () => Promise<void>
}): Promise<
  | { status: 'pushed' | 'already-published'; head: string }
  | { status: 'refused' | 'uncertain'; reason: string; detail?: string }
> {
  const { git, cwd, origin, branch, base, tip, from } = input
  const head = await git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { status: 'refused', reason: 'local-head-mismatch' }
  const remote = await readFeatureRemote(git, cwd, origin, branch)
  if (remote === tip) return { status: 'already-published', head: tip }
  if (remote !== from) return { status: 'refused', reason: 'remote-lease-mismatch' }
  const ancestor = from ?? (await readFeatureRemote(git, cwd, origin, base))
  if (ancestor === null) return { status: 'refused', reason: 'remote-base-missing' }
  if ((await git(cwd, ['merge-base', '--is-ancestor', `${ancestor}^{commit}`, `${tip}^{commit}`])).code !== 0)
    return { status: 'refused', reason: 'tip-not-fast-forward' }
  await input.beforePush()
  const destination = `refs/heads/${branch}`
  const pushed = await git(cwd, [
    'push',
    '--porcelain',
    '--no-follow-tags',
    `--force-with-lease=${destination}:${from ?? ''}`,
    'origin',
    `${tip}^{commit}:${destination}`,
  ])
  // Git skips its lease check when the destination is already at the requested tip.
  if (/^=\t/m.test(pushed.stdout)) return { status: 'refused', reason: 'remote-lease-mismatch' }
  if (pushed.code !== 0 && /stale info/i.test(`${pushed.stdout}\n${pushed.stderr}`))
    return { status: 'refused', reason: 'remote-lease-mismatch', detail: pushDiagnostic(pushed.stderr) }
  try {
    if ((await readFeatureRemote(git, cwd, origin, branch)) === tip) return { status: 'pushed', head: tip }
  } catch {
    // A failed observation after starting the push cannot prove that no update occurred.
  }
  return {
    status: 'uncertain',
    reason: 'push-unconfirmed',
    ...(pushed.code === 0 ? {} : { detail: pushDiagnostic(pushed.stderr) }),
  }
}

/**
 * git's stderr is returned whole. It can echo a credential (a credential-bearing push URL, curl tracing);
 * accepted: the session's agent sees the same text when it runs git itself (operator decision, #1035).
 */
function pushDiagnostic(stderr: string): string {
  return `git push: ${stderr.trim() || 'no stderr'}`
}
