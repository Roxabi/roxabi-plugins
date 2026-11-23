import type { Gh } from '../adapters/github/types.ts'
import { credentialFreePushUrl } from './fix-publish-url.ts'
import type { GitRunner } from './workflow-checkout.ts'

const FULL_SHA = /^[0-9a-f]{40}$/

/** Read all effective push URLs (including Git's URL rewriting), never just the first. */
export async function featureOrigin(git: GitRunner, gh: Gh, cwd: string, repository: string): Promise<string> {
  const [fetch, push] = await Promise.all([
    git(cwd, ['remote', 'get-url', '--all', 'origin']),
    git(cwd, ['remote', 'get-url', '--push', '--all', 'origin']),
  ])
  const fetchUrl = fetch.stdout.trim()
  const pushUrl = push.stdout.trim()
  if (pushUrl.includes('\n')) throw new Error('multiple-origin-push-urls')
  if (fetch.code !== 0 || push.code !== 0 || !credentialFreePushUrl(fetchUrl) || !credentialFreePushUrl(pushUrl))
    throw new Error('origin-unreadable')
  for (const url of new Set([fetchUrl, pushUrl])) {
    const resolved = JSON.parse(await gh(cwd, ['repo', 'view', url, '--json', 'nameWithOwner,url']))
    if (resolved?.nameWithOwner !== repository || resolved.url !== `https://github.com/${repository}`)
      throw new Error('origin-repository-mismatch')
  }
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
    '--no-follow-tags',
    `--force-with-lease=${destination}:${from ?? ''}`,
    'origin',
    `${tip}^{commit}:${destination}`,
  ])
  if (pushed.code !== 0 && /stale info/i.test(pushed.stderr))
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

async function authorizeObservedTip(
  branch: string,
  tip: string,
  effect: () => Promise<{ ok: true } | { ok: false; reason: string }>,
) {
  const confirmedRemote = { branch, tip }
  try {
    const authorized = await effect()
    return authorized.ok ? { ok: true as const, remoteTip: tip } : { ...authorized, confirmedRemote }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(`${message} (confirmed remote tip ${branch} ${tip})`, { cause: error }), {
      confirmedRemote,
    })
  }
}

export async function proveAuthorizedBranch(
  git: GitRunner,
  cwd: string,
  branch: string,
  tip: string,
  authority: {
    effect: () => Promise<{ ok: true } | { ok: false; reason: string }>
    beforePush: () => Promise<{ ok: true } | { ok: false; reason: string }>
  },
): Promise<
  | { ok: true; remoteTip: string }
  | { ok: false; reason: string; detail?: string; confirmedRemote?: { branch: string; tip: string } }
> {
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== branch)
    return { ok: false, reason: 'implementation-branch-mismatch' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { ok: false, reason: 'implementation-head-mismatch' }
  const observed = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const observedTip = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (observed.code === 0 && observedTip === tip)
    return authorizeObservedTip(branch, observedTip, () => authority.effect())
  const authorized = await authority.beforePush()
  if (!authorized.ok) return authorized
  // The verified SHA, not `HEAD`: a checkout moved after the check above cannot be published here.
  // `^{commit}` cannot name a ref, so a local branch named like the SHA cannot shadow it.
  const pushed = await git(cwd, ['push', 'origin', `${tip}^{commit}:refs/heads/${branch}`])
  if (pushed.code !== 0)
    return { ok: false, reason: 'implementation-push-failed', detail: pushDiagnostic(pushed.stderr) }
  const remote = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || remoteTip !== tip) return { ok: false, reason: 'implementation-remote-unconfirmed' }
  return { ok: true, remoteTip }
}

/** Prove a detached candidate is already the freshly observed published base. */
export async function proveAuthorizedPublishedBase(
  git: GitRunner,
  cwd: string,
  gh: (cwd: string, args: string[]) => Promise<string>,
  repository: string,
  base: string,
  tip: string,
  authorized: () => Promise<{ ok: true } | { ok: false; reason: string }>,
): Promise<{ ok: true; remoteTip: string } | { ok: false; reason: string }> {
  const origin = await git(cwd, ['remote', 'get-url', 'origin'])
  if (origin.code !== 0 || origin.stdout.trim() === '') return { ok: false, reason: 'integration-origin-unreadable' }
  try {
    const observed: unknown = JSON.parse(
      await gh(cwd, ['repo', 'view', origin.stdout.trim(), '--json', 'nameWithOwner']),
    )
    if (
      observed === null ||
      typeof observed !== 'object' ||
      !('nameWithOwner' in observed) ||
      observed.nameWithOwner !== repository
    )
      return { ok: false, reason: 'integration-origin-mismatch' }
  } catch {
    return { ok: false, reason: 'integration-origin-unreadable' }
  }
  const firstAuthority = await authorized()
  if (!firstAuthority.ok) return firstAuthority
  const fetched = await git(cwd, ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`])
  if (fetched.code !== 0) return { ok: false, reason: 'integration-base-unreadable' }
  const [branch, head, local, remote] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(cwd, ['rev-parse', '--verify', `origin/${base}^{commit}`]),
    git(cwd, ['ls-remote', 'origin', `refs/heads/${base}`]),
  ])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (
    branch.code !== 0 ||
    branch.stdout.trim() !== 'HEAD' ||
    head.code !== 0 ||
    head.stdout.trim() !== tip ||
    local.code !== 0 ||
    local.stdout.trim() !== tip ||
    remote.code !== 0 ||
    remoteTip !== tip
  )
    return { ok: false, reason: 'integration-base-not-published' }
  const secondAuthority = await authorized()
  if (!secondAuthority.ok) return secondAuthority
  const [originAgain, remoteAgain, headAgain, branchAgain, statusAgain] = await Promise.all([
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['ls-remote', 'origin', `refs/heads/${base}`]),
    git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--porcelain']),
  ])
  if (
    originAgain.code !== 0 ||
    originAgain.stdout.trim() !== origin.stdout.trim() ||
    remoteAgain.code !== 0 ||
    remoteAgain.stdout.trim().split(/\s+/)[0] !== tip ||
    headAgain.code !== 0 ||
    headAgain.stdout.trim() !== tip ||
    branchAgain.code !== 0 ||
    branchAgain.stdout.trim() !== 'HEAD' ||
    statusAgain.code !== 0 ||
    statusAgain.stdout.trim() !== ''
  )
    return { ok: false, reason: 'integration-base-changed' }
  return { ok: true, remoteTip }
}
