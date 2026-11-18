import type { Scope } from '../engine/record-values.ts'
import type { UwDeliveryFacts } from '../engine/uw-completion-types.ts'
import type { GitRunner } from './workflow-checkout.ts'
export type ContextHandoffCandidate = Readonly<{
  repository: string
  branch: string
  base: string
  head: string
  remoteBranch: string | null
  remoteBase: string
  clean: true
}>

export function contextHandoffDeliveryClear(delivery: UwDeliveryFacts, uw: Scope): boolean {
  return (
    delivery.uw.repository === uw.repository &&
    delivery.uw.target === uw.target &&
    delivery.pullRequests.length === 0 &&
    delivery.integrations.length === 0 &&
    delivery.commits.length === 0
  )
}

type Input = {
  git: GitRunner
  gh: (cwd: string, args: string[]) => Promise<string>
  cwd: string
  repository: string
  branch: string
  base: string
  baseline: string
}

function remoteRef(stdout: string, ref: string): string | null | undefined {
  if (stdout.trim() === '') return null
  const lines = stdout.trim().split('\n')
  if (lines.length !== 1) return undefined
  const match = /^([0-9a-f]{40})\s+(\S+)$/.exec(lines[0] ?? '')
  return match?.[2] === ref ? match[1] : undefined
}

/** Read-only observation: an empty command claim is never evidence about the candidate. */
export async function observeContextHandoffCandidate(
  input: Input,
): Promise<{ ok: true; value: ContextHandoffCandidate } | { ok: false; reason: string }> {
  const fail = () => ({ ok: false as const, reason: 'context-handoff-candidate-unconfirmed' })
  try {
    const { git, cwd, repository, branch, base, baseline } = input
    if (!/^[0-9a-f]{40}$/.test(baseline) || !branch || !base || branch === base) return fail()
    const origin = await git(cwd, ['remote', 'get-url', 'origin'])
    if (origin.code !== 0 || !origin.stdout.trim()) return fail()
    const repo: unknown = JSON.parse(
      await input.gh(cwd, ['repo', 'view', origin.stdout.trim(), '--json', 'nameWithOwner']),
    )
    if (repo === null || typeof repo !== 'object' || !('nameWithOwner' in repo) || repo.nameWithOwner !== repository)
      return fail()
    const [head, current, status, baseRef, branchRef] = await Promise.all([
      git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}']),
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['status', '--porcelain', '--untracked-files=all']),
      git(cwd, ['ls-remote', '--refs', 'origin', `refs/heads/${base}`]),
      git(cwd, ['ls-remote', '--refs', 'origin', `refs/heads/${branch}`]),
    ])
    if ([head, current, status, baseRef, branchRef].some((result) => result.code !== 0)) return fail()
    const remoteBase = remoteRef(baseRef.stdout, `refs/heads/${base}`)
    const remoteBranch = remoteRef(branchRef.stdout, `refs/heads/${branch}`)
    if (
      head.stdout.trim() !== baseline ||
      current.stdout.trim() !== branch ||
      status.stdout !== '' ||
      remoteBase == null ||
      remoteBranch === undefined ||
      (remoteBranch !== null && remoteBranch !== baseline)
    )
      return fail()
    return { ok: true, value: { repository, branch, base, head: baseline, remoteBranch, remoteBase, clean: true } }
  } catch {
    return fail()
  }
}
