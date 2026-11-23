import { type DecodedHistory, githubScope, selectWorkflowBinding } from '../../dist/contracts.js'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { authenticateOwnPullRequests } from '../../roxabi/feature-disarm-ownership.ts'
import { loadContracts } from '../../roxabi/feature-engine.ts'
import {
  branchCandidates,
  type Candidate,
  exactIssueCandidates,
  uniqueCandidates,
} from './epic-driver-containment-discovery'
import { issueHistory } from './epic-driver-github'
import { gh, Refused } from './epic-driver-runtime'

type Scope = { repository: string; target: string }
type Owner = { repo: string; full: string; epic: number; mandateId: string; child: Scope; number: number }

function ownedMandate(mandate: MandateRecord, context: Owner): boolean {
  const own = mandate.payload.ownSpec.uw
  const parent = mandate.payload.parent
  return (
    (mandate.payload.role === 'feature' || mandate.payload.role === 'epic') &&
    own.repository === context.full &&
    own.target === context.child.target &&
    parent?.kind === 'mandate' &&
    parent.scope.repository === context.full &&
    parent.scope.target === `${context.full}#${context.epic}` &&
    parent.recordId === context.mandateId
  )
}

function ownedBranches(history: DecodedHistory, context: Owner): Set<string> {
  const branches = new Set<string>()
  for (const operation of history.operations) {
    const record = operation.record
    if (operation.status !== 'complete' || operation.authority !== 'accounted' || record?.kind !== 'mandate') continue
    if (ownedMandate(record, context) && record.payload.branch) branches.add(record.payload.branch)
  }
  return branches
}

async function childHistory(context: Owner): Promise<DecodedHistory> {
  const history = await issueHistory(context.repo, context.full, context.number)
  const hasOwnedMandate = history.operations.some(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority === 'accounted' &&
      operation.record?.kind === 'mandate' &&
      ownedMandate(operation.record, context),
  )
  if (
    !history.source.complete ||
    history.operations.some((operation) => {
      const claimsMandate =
        operation.record?.kind === 'mandate' ||
        operation.kind === 'mandate' ||
        operation.claimedKinds.includes('mandate')
      return (
        claimsMandate &&
        (operation.authority === 'foreign'
          ? !hasOwnedMandate
          : operation.status !== 'complete' ||
            operation.record?.kind !== 'mandate' ||
            operation.authority === 'authority')
      )
    })
  )
    throw new Refused(`containment history for ${context.child.target} is unconfirmed`)
  return history
}

async function childCandidates(context: Owner): Promise<{ candidates: Candidate[]; history: DecodedHistory }> {
  const linked = exactIssueCandidates(context)
  const history = await childHistory(context)
  for (const branch of ownedBranches(history, context)) linked.push(...branchCandidates(context, branch))
  return { candidates: uniqueCandidates(linked, context.full, context.child.target), history }
}

async function authenticateCandidate(context: Owner, history: DecodedHistory, pr: Candidate): Promise<void> {
  const prHistory = await issueHistory(context.repo, context.full, pr.number)
  const selected = selectWorkflowBinding({
    pullRequest: githubScope(context.full, pr.number),
    histories: [prHistory, history],
    native: { branch: pr.headRefName, base: pr.baseRefName },
  })
  if (selected.status !== 'bound') throw new Refused(`containment PR #${pr.number} binding is ${selected.status}`)
  if (!ownedMandate(selected.mandateRecord, context))
    throw new Refused(`containment PR #${pr.number} is not owned by the selected parent mandate`)
}

function acceptedNumber(full: string, child: Scope): number {
  const prefix = `${full}#`
  if (child.repository !== full || !child.target.startsWith(prefix))
    throw new Refused(`containment accepted child ${child.target} is outside ${full}`)
  const number = Number(child.target.slice(prefix.length))
  if (!Number.isSafeInteger(number) || number <= 0 || child.target !== `${prefix}${number}`)
    throw new Refused(`containment accepted child ${child.target} is invalid`)
  return number
}

async function authenticateBatch(
  context: Owner,
  history: DecodedHistory,
  candidates: readonly Candidate[],
): Promise<void> {
  for (const pr of candidates) await authenticateCandidate(context, history, pr)
}

export async function discoverOwnPrs(
  repo: string,
  full: string,
  epic: number,
  mandate: MandateRecord,
  scope: Scope,
): Promise<{ ticket: number; pr: number }[]> {
  const context = { repo, full, number: epic }
  const candidates = exactIssueCandidates(context)
  if (mandate.payload.branch) candidates.push(...branchCandidates(context, mandate.payload.branch))
  const numbers = new Set(
    uniqueCandidates(candidates, full, scope.target)
      .filter((pr) => pr.state !== 'MERGED')
      .map((pr) => pr.number),
  )
  const loaded = await loadContracts()
  if ('missing' in loaded) throw new Refused(`containment contracts unavailable: ${loaded.missing}`)
  const result = await authenticateOwnPullRequests(async (cwd, args) => gh(cwd, args), repo, full, numbers, {
    loaded,
    mandate: { kind: 'mandate', recordId: mandate.recordId, scope },
  })
  if (result.incomplete)
    throw new Refused(`containment own PR ownership unconfirmed: ${JSON.stringify(result.evidence)}`)
  return [...result.numbers].map((pr) => ({ ticket: epic, pr }))
}

export async function discoverAcceptedChildPrs(
  repo: string,
  full: string,
  epic: number,
  mandateId: string,
  children: readonly { scope: Scope }[],
): Promise<{ ticket: number; pr: number }[]> {
  const found = new Map<number, { ticket: number; pr: number }>()
  for (const { scope: child } of children) {
    const number = acceptedNumber(full, child)
    const context = { repo, full, epic, mandateId, child, number }
    const discovered = await childCandidates(context)
    const history = discovered.history
    const candidates = discovered.candidates.filter((pr) => pr.state !== 'MERGED')
    await authenticateBatch(context, history, candidates)
    for (const pr of candidates) {
      const prior = found.get(pr.number)
      if (prior && prior.ticket !== number) throw new Refused(`containment PR #${pr.number} has conflicting owners`)
      found.set(pr.number, { ticket: number, pr: pr.number })
    }
  }
  return [...found.values()]
}
