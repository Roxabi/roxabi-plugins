import type { GitRunner } from './workflow-checkout.ts'

export async function proveAuthorizedBranch(
  git: GitRunner,
  cwd: string,
  branch: string,
  tip: string,
  authority: {
    effect: () => Promise<{ ok: true } | { ok: false; reason: string }>
    beforePush: () => Promise<{ ok: true } | { ok: false; reason: string }>
  },
): Promise<{ ok: true; remoteTip: string } | { ok: false; reason: string }> {
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== branch)
    return { ok: false, reason: 'implementation-branch-mismatch' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { ok: false, reason: 'implementation-head-mismatch' }
  const observed = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const observedTip = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (observed.code === 0 && observedTip === tip) {
    const authorized = await authority.effect()
    return authorized.ok ? { ok: true, remoteTip: observedTip } : authorized
  }
  const authorized = await authority.beforePush()
  if (!authorized.ok) return authorized
  const pushed = await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.code !== 0) return { ok: false, reason: 'implementation-push-failed' }
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
