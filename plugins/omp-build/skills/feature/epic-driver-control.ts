import { type DecodedHistory, githubScope, resolveAcceptedSpec, selectApplicableMandate } from '../../dist/contracts.js'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import { confirmedEpicMandate, evidenceText, localInhibit, readEpicAuthority } from './epic-driver-authority'
import { discoverAcceptedChildPrs } from './epic-driver-containment'
import { gather } from './epic-driver-gather'
import { historyFor, issueHistory, repoName } from './epic-driver-github'
import { type Disarm, disarm } from './epic-driver-publication'
import { Assisted, Refused } from './epic-driver-runtime'
import { nextStep } from './epic-next-step'
import { type EpicStepName, epicStepName, type Step } from './epic-types'

export type EpicControlState = 'active' | 'paused' | 'abandoned' | 'revoked'

/** Authenticated epic mandate for control only. Not a continuation or branch-switch grant. */
export type EpicControlTarget = {
  epic: number
  repository: string
  mandateId: string
  run: string
  base: string
  control: EpicControlState
  openPrs: { ticket: number; pr: number }[]
}

/** Disarm read-back. `control` is the observed state, not a pause confirmation. */
export type EpicDisarmEvidence = {
  control: EpicControlState
  mandateId: string
  disarmed: Record<number, Disarm>
  failed: { pr: number; error: string }[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function mandateWithId(history: DecodedHistory, recordId: string): MandateRecord | null {
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.authority === 'foreign') continue
    if (operation.record?.kind === 'mandate' && operation.record.recordId === recordId) return operation.record
  }
  return null
}

function namedTerminalMandate(history: DecodedHistory, control: 'abandoned' | 'revoked'): MandateRecord | null {
  const expectedControl = control === 'abandoned' ? 'abandon' : 'select-successor'
  const reference = control === 'abandoned' ? 'mandate' : 'predecessor'
  for (const operation of [...history.operations].reverse()) {
    if (operation.status !== 'complete' || operation.authority === 'foreign') continue
    const record = operation.record
    if (record?.kind !== 'operator-control' || record.payload.control !== expectedControl) continue
    const ref = (record.payload as unknown as Record<string, unknown>)[reference]
    if (!isObject(ref) || typeof ref.recordId !== 'string') continue
    const mandate = mandateWithId(history, ref.recordId)
    if (mandate !== null) return mandate
  }
  return null
}

function parentScopeOf(
  record: DecodedHistory['operations'][number]['record'],
): { repository: string; target: string } | null {
  const payload = record?.kind === 'mandate' ? record.payload : null
  if (!isObject(payload) || !('parent' in payload) || payload.parent == null) return null
  if (!isObject(payload.parent) || !isObject(payload.parent.scope)) {
    throw new Refused('epic mandate parent reference is unreadable')
  }
  const { repository, target } = payload.parent.scope
  if (typeof repository !== 'string' || typeof target !== 'string') {
    throw new Refused('epic mandate parent reference is unreadable')
  }
  return { repository, target }
}

async function parentMandateHistories(repo: string, history: DecodedHistory): Promise<DecodedHistory[]> {
  const external: DecodedHistory[] = []
  for (const operation of history.operations) {
    const scope = parentScopeOf(operation.record)
    if (scope === null) continue
    const parentHistory = await historyFor(repo, scope)
    if (!parentHistory.source.complete) throw new Refused('parent mandate history is incomplete')
    external.push(parentHistory)
  }
  return external
}

function selectedControlTarget(
  history: DecodedHistory,
  external: DecodedHistory[],
  epic: number,
): { mandate: MandateRecord; control: EpicControlState } {
  const selected = selectApplicableMandate(history, external)
  if (selected.status === 'applicable') {
    const inhibit = localInhibit(history, selected.mandate.recordId)
    const control = inhibit === 'abandon' ? 'abandoned' : inhibit === 'pause' ? 'paused' : 'active'
    return { mandate: selected.mandate, control }
  }
  if (selected.reason === 'paused') {
    const mandate = mandateWithId(history, selected.pause.mandate.recordId)
    if (mandate === null) throw new Refused(`epic #${epic} paused mandate record is not intact`)
    return { mandate, control: 'paused' }
  }
  if (selected.reason === 'abandoned' || selected.reason === 'revoked') {
    const mandate = namedTerminalMandate(history, selected.reason)
    if (mandate === null) throw new Refused(`epic #${epic} ${selected.reason} mandate record is not intact`)
    return { mandate, control: selected.reason }
  }
  if (selected.reason === 'missing') throw new Assisted(`no confirmed mandate authorizes epic #${epic}`)
  throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
}

/**
 * The intact normal mandate, including when continuation is paused, abandoned,
 * or revoked. It reads the authenticated accepted child projection but does not
 * authorize a delivery step or a branch switch.
 */
export async function readEpicControlTarget(repo: string, epic: number): Promise<EpicControlTarget> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  const external = await parentMandateHistories(repo, history)
  const target = selectedControlTarget(history, external, epic)
  const accepted = resolveAcceptedSpec(target.mandate, [history, ...external])
  if (!accepted.ok) {
    throw new Refused(`epic parent accepted Spec ${accepted.reason}: ${evidenceText(accepted.evidence)}`)
  }
  const fields = confirmedEpicMandate(target.mandate, accepted.spec)
  const openPrs = await discoverAcceptedChildPrs(repo, full, epic, fields.mandateId, fields.children)
  return {
    epic,
    repository: full,
    mandateId: fields.mandateId,
    run: fields.run,
    base: fields.base,
    control: target.control,
    openPrs,
  }
}

/**
 * Disarm open PRs of an authenticated intact normal mandate, active, paused,
 * abandoned, or revoked. A failed pause publication leaves the remote mandate
 * active; this call still disarms and never authorizes a next step.
 */
export async function disarmEpicControlTarget(repo: string, epic: number): Promise<EpicDisarmEvidence> {
  const target = await readEpicControlTarget(repo, epic)
  const disarmed: Record<number, Disarm> = {}
  const failed: { pr: number; error: string }[] = []
  for (const { pr } of target.openPrs) {
    try {
      disarmed[pr] = await disarm(repo, pr)
    } catch (error) {
      failed.push({ pr, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { control: target.control, mandateId: target.mandateId, disarmed, failed }
}

export type EpicRangeReviewRequest = {
  repository: string
  target: string
  runId: string
  range: string
  candidateGitSHA: string
}

/** Confirmed final-review context for the native range review. Does not dispatch it. */
export async function epicFinalReviewRequest(repo: string, epic: number): Promise<EpicRangeReviewRequest> {
  const authority = await readEpicAuthority(repo, epic)
  const { facts, parentAdmission } = await gather(repo, epic, authority.run, authority.base)
  if (!parentAdmission.deliverable.ok)
    throw new Refused(
      `epic #${epic} native delivery admission refused: ${evidenceText(parentAdmission.deliverable.diagnostics)}`,
    )
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || !step.range) {
    throw new Refused(`the driver expects no final review (next: ${step.action})`)
  }
  const candidateGitSHA = step.range.split('..')[1] ?? ''
  if (!/^[0-9a-f]{40}$/.test(candidateGitSHA))
    throw new Refused(`final review range ${step.range} has no candidate sha`)
  return {
    repository: authority.repository,
    target: githubScope(authority.repository, epic).target,
    runId: authority.run,
    range: step.range,
    candidateGitSHA,
  }
}

export type EpicStepRead = {
  run: string
  base: string
  step: Step
  name: EpicStepName
  land: null
}

/**
 * One `nextStep` read for traversal. Git status and refs are read, not moved.
 * No fetch, switch, disarm, stop publication, or hook. A `stop` is returned,
 * not recorded. Landing is `landOutcome`, not this read, so `land` is null.
 */
export async function readEpicStep(repo: string, epic: number): Promise<EpicStepRead> {
  const authority = await readEpicAuthority(repo, epic)
  const { facts } = await gather(repo, epic, authority.run, authority.base)
  const step = nextStep(facts)
  return { run: authority.run, base: authority.base, step, name: epicStepName(step), land: null }
}
