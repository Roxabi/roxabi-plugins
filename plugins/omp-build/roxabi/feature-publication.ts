import type { GitRunner } from './workflow-pins.ts'

export async function proveAuthorizedBranch(
  git: GitRunner,
  cwd: string,
  branch: string,
  tip: string,
  authorizePush: () => Promise<boolean>,
): Promise<{ ok: true; remoteTip: string } | { ok: false; reason: string }> {
  const current = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (current.code !== 0 || current.stdout.trim() !== branch)
    return { ok: false, reason: 'implementation-branch-mismatch' }
  const head = await git(cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== tip) return { ok: false, reason: 'implementation-head-mismatch' }
  const observed = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const observedTip = observed.stdout.trim().split(/\s+/)[0] ?? ''
  if (observed.code === 0 && observedTip === tip) return { ok: true, remoteTip: observedTip }
  if (!(await authorizePush())) return { ok: false, reason: 'implementation-admission-refused' }
  const pushed = await git(cwd, ['push', 'origin', `HEAD:refs/heads/${branch}`])
  if (pushed.code !== 0) return { ok: false, reason: 'implementation-not-remote' }
  const remote = await git(cwd, ['ls-remote', 'origin', `refs/heads/${branch}`])
  const remoteTip = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (remote.code !== 0 || remoteTip !== tip) return { ok: false, reason: 'implementation-not-remote' }
  return { ok: true, remoteTip }
}
