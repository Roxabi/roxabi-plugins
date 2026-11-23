import type { Gh } from '../../adapters/github/types.ts'
import { githubScope, readWorkflowBinding } from '../../dist/contracts.js'
import { confirmWorkflowBinding, readFeaturePr } from '../../roxabi/feature-admission.ts'
import { isRecord } from '../../roxabi/feature-engine.ts'
import {
  type FeatureCoordinates,
  type LiveFeatureMandate as Live,
  readLiveFeatureMandate,
} from '../../roxabi/feature-live-mandate.ts'
import { featureOrigin, pushFeatureTip, readFeatureRemote } from '../../roxabi/feature-publication.ts'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { findOpenPr, openPr, parseRequiredContexts } from './workflow-pr.js'

export const SHA = /^[0-9a-f]{40}$/
type Effect =
  | { command: 'push'; tip: string; from: string | null; pr: number | null }
  | { command: 'open-pr'; tip: string }
  | { command: 'land'; pr: number; head: string }
  | { command: 'finish'; pr: number }
export type Input = FeatureCoordinates & Effect
export type Runtime = { cwd: string; gh: Gh; git: GitRunner }

async function boundPr(runtime: Runtime, live: Live, pr: number) {
  const { cwd, gh } = runtime
  const repository = live.scope.repository
  const native = await readFeaturePr(cwd, gh, repository, pr)
  if (native.branch !== live.branch || native.base !== live.base) throw new Error('pr-coordinates-mismatch')
  const binding = await readWorkflowBinding(githubScope(repository, pr), withRoxabiGitHubPolicy({ cwd, gh }))
  if (!binding.ok) throw new Error(`pr-binding-${binding.status}`)
  if (binding.value.binding.kind !== 'workflow-binding') throw new Error('pr-binding-mismatch')
  const ref = binding.value.binding.payload.mandate
  if (
    ref.scope.repository !== repository ||
    ref.scope.target !== live.scope.target ||
    ref.recordId !== live.ref.recordId ||
    binding.value.observed.head !== native.head ||
    binding.value.native.branch !== native.branch ||
    binding.value.native.base !== native.base
  )
    throw new Error('pr-binding-mismatch')
  return native
}

async function assertDefaultBase({ cwd, gh }: Runtime, live: Live) {
  const repo = JSON.parse(
    await gh(cwd, ['repo', 'view', live.scope.repository, '--json', 'nameWithOwner,defaultBranchRef']),
  )
  if (repo?.nameWithOwner !== live.scope.repository || repo.defaultBranchRef?.name !== live.base)
    throw new Error('default-base-mismatch')
}

async function push(
  input: Extract<Input, { command: 'push' }>,
  runtime: Runtime,
  live: Live,
  origin: string,
  refresh: () => Promise<void>,
) {
  const { cwd, git, gh } = runtime
  const { issue, repository, tip, from, pr } = input
  const { base, branch } = live
  const verifyPr = async (allowedHeads: readonly (string | null)[]) => {
    const candidate = await findOpenPr(cwd, branch, base, gh, repository)
    if (candidate !== pr) throw new Error('push-pr-mismatch')
    if (pr !== null) {
      const observed = await boundPr(runtime, live, pr)
      if (observed.state !== 'OPEN' || !allowedHeads.includes(observed.head)) throw new Error('push-pr-head-mismatch')
    }
  }
  await verifyPr([from, tip])
  const result = await pushFeatureTip({
    git,
    cwd,
    origin,
    branch,
    base,
    tip,
    from,
    beforePush: async () => {
      await verifyPr([from])
      await refresh()
      if ((await featureOrigin(git, gh, cwd, repository)) !== origin) throw new Error('origin-changed')
    },
  })
  if ('detail' in result && result.detail) console.error(result.detail)
  if (!('head' in result)) return { status: result.status, reason: result.reason, repository, issue, branch }
  if (pr !== null) {
    try {
      await verifyPr([tip])
    } catch {
      return { status: 'uncertain' as const, reason: 'push-pr-unconfirmed', repository, issue, branch, head: tip, pr }
    }
  }
  return { ...result, repository, issue, branch, base, ...(pr === null ? {} : { pr }) }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function knownPull(error: unknown): number | null {
  return isRecord(error) && typeof error.pr === 'number' ? error.pr : null
}

async function open(
  input: Extract<Input, { command: 'open-pr' }>,
  runtime: Runtime,
  live: Live,
  origin: string,
  refresh: () => Promise<void>,
) {
  const { cwd, gh, git } = runtime
  const { tip, repository, issue, mandate } = input
  const { base, branch } = live
  const guard = async () => {
    if ((await featureOrigin(git, gh, cwd, repository)) !== origin) throw new Error('origin-changed')
    if ((await readFeatureRemote(git, cwd, origin, branch)) !== tip) throw new Error('published-tip-mismatch')
  }
  await guard()
  const baseTip = await readFeatureRemote(git, cwd, origin, base)
  if (baseTip === null) throw new Error('remote-base-missing')
  const delta = await git(cwd, ['rev-list', '-1', `${baseTip}^{commit}..${tip}^{commit}`])
  if (delta.code !== 0 || !SHA.test(delta.stdout.trim())) throw new Error('pr-branch-empty-or-unreadable')
  const subject = JSON.parse(await gh(cwd, ['issue', 'view', String(issue), '--repo', repository, '--json', 'title']))
  if (typeof subject?.title !== 'string' || subject.title.trim() === '') throw new Error('issue-title-unreadable')
  const details = { repository, issue, branch, base, head: tip }
  let createAttempted = false
  const liveTip = async () => {
    await refresh()
    await guard()
  }
  try {
    const result = await openPr(
      cwd,
      { issue, branch, base, title: subject.title },
      {
        gh,
        repository,
        beforeCreate: async () => {
          await liveTip()
          createAttempted = true
        },
        confirm: (pr) =>
          confirmWorkflowBinding({
            cwd,
            gh,
            pr,
            issue,
            branch,
            base,
            expected: { repository, mandate, head: tip, live: liveTip },
          }),
      },
    )
    if (result.binding === undefined) throw new Error('binding-unconfirmed')
    return {
      status: result.status,
      ...details,
      pr: result.number,
      url: `https://github.com/${repository}/pull/${result.number}`,
      binding: result.binding,
    }
  } catch (error) {
    const knownPr = knownPull(error)
    if (knownPr === null && !createAttempted) throw error
    console.error(messageOf(error))
    return {
      status: 'uncertain' as const,
      reason: knownPr === null ? 'pr-create-unconfirmed' : 'binding-unconfirmed',
      ...details,
      ...(knownPr === null ? {} : { pr: knownPr }),
    }
  }
}

async function land(
  input: Extract<Input, { command: 'land' }>,
  runtime: Runtime,
  live: Live,
  refresh: () => Promise<void>,
) {
  const { repository, issue, pr, head } = input
  const { cwd, gh } = runtime
  const before = await boundPr(runtime, live, pr)
  if (before.head !== head) throw new Error('pr-head-mismatch')
  const details = { repository, issue, pr, head, url: before.url, branch: live.branch, base: live.base }
  if (before.state === 'MERGED') return { status: 'merged' as const, ...details, mergeCommit: before.mergeCommit }
  if (before.state !== 'OPEN') throw new Error('pr-not-open')
  const rules = await gh(cwd, ['api', `repos/${repository}/rules/branches/${encodeURIComponent(live.base)}`])
  if (!Array.isArray(JSON.parse(rules)) || !parseRequiredContexts(rules).has('review'))
    return { status: 'refused' as const, reason: 'no-verdict-lock', ...details }
  const current = await boundPr(runtime, live, pr)
  if (current.state !== 'OPEN' || current.head !== head) throw new Error('pr-head-changed')
  await refresh()
  try {
    await gh(cwd, ['pr', 'merge', String(pr), '--repo', repository, '--merge', '--match-head-commit', head])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    const waiting = /required status check|checks? (?:are |is )?(?:pending|expected|failing)|not mergeable/i.test(
      message,
    )
    return { status: waiting ? ('waiting' as const) : ('refused' as const), reason: 'merge-refused', ...details }
  }
  const mergeCommit = await confirmedMerge(runtime, live, pr, head)
  return mergeCommit === null
    ? { status: 'uncertain' as const, reason: 'merge-unconfirmed', ...details }
    : { status: 'merged' as const, ...details, mergeCommit }
}

async function confirmedMerge({ cwd, gh }: Runtime, live: Live, pr: number, head: string): Promise<string | null> {
  try {
    const merged = await readFeaturePr(cwd, gh, live.scope.repository, pr)
    if (merged.state === 'MERGED' && merged.head === head && merged.branch === live.branch && merged.base === live.base)
      return merged.mergeCommit
  } catch (error) {
    console.error(messageOf(error))
  }
  return null
}

async function finish(
  input: Extract<Input, { command: 'finish' }>,
  runtime: Runtime,
  live: Live,
  refresh: () => Promise<void>,
) {
  const { issue, repository, pr } = input
  const { cwd, gh } = runtime
  const native = await boundPr(runtime, live, pr)
  if (native.state !== 'MERGED') throw new Error('pr-not-merged')
  const uw = await createInstalledUwOperations({
    cwd,
    gh,
    operator: {
      async executeConfirmed() {
        return { status: 'refused', diagnostics: [] }
      },
    },
  })
  const read = await uw.readUw(live.scope)
  const completion = read.completion.completions.get(`${repository}\0${live.scope.target}`)
  if (completion?.state !== 'complete' || completion.role !== 'leaf' || completion.code.head !== native.head)
    throw new Error('close-linked-completion-unavailable')
  await refresh()
  const result = await uw.closeLinked({
    uw: live.scope,
    mandate: live.ref,
    pullRequest: githubScope(repository, pr),
    completion,
  })
  const details = { repository, issue, pr, head: native.head, mergeCommit: native.mergeCommit, url: native.url }
  if (result.status === 'written') return { status: 'finished' as const, ...details }
  const reason = ('diagnostics' in result && result.diagnostics[0]?.code) || `close-linked-${result.status}`
  return {
    status:
      result.status === 'partial' || result.status === 'uncertain' ? ('uncertain' as const) : ('refused' as const),
    reason,
    ...details,
  }
}

export async function act(input: Input, runtime: Runtime) {
  const read = () => readLiveFeatureMandate({ ...input, ...runtime }, input.command !== 'finish')
  const live = await read()
  const refresh = async () => {
    const current = await read()
    if (current.branch !== live.branch || current.base !== live.base) throw new Error('mandate-coordinates-changed')
  }
  if (input.command === 'finish') return finish(input, runtime, live, refresh)
  await assertDefaultBase(runtime, live)
  const origin = await featureOrigin(runtime.git, runtime.gh, runtime.cwd, input.repository)
  if (input.command === 'push') return push(input, runtime, live, origin, refresh)
  if (input.command === 'open-pr') return open(input, runtime, live, origin, refresh)
  return land(input, runtime, live, refresh)
}

export function refusalReason(error: unknown): string {
  const message = messageOf(error)
  if (isRecord(error) && typeof error.reason === 'string') return error.reason
  if (/^[a-z][a-z0-9:-]*$/.test(message)) return message
  console.error(message)
  return 'feature-unavailable'
}
