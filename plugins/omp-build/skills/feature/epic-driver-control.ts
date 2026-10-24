import { type DecodedHistory, githubScope, selectApplicableMandate } from '../../dist/contracts.js'
import {
  childGrants,
  type EpicChildGrant,
  evidenceText,
  extensionScopes,
  localInhibit,
  readEpicAuthority,
} from './epic-driver-authority'
import { gather } from './epic-driver-gather'
import { historyFor, issueHistory, repoName } from './epic-driver-github'
import { type Disarm, disarm } from './epic-driver-publication'
import { Assisted, Refused } from './epic-driver-runtime'
import { BASE_NAME, RUN_ID } from './epic-naming'
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

function lastIntactEpicMandate(history: DecodedHistory): { recordId: string; payload: Record<string, unknown> } | null {
  let found: { recordId: string; payload: Record<string, unknown> } | null = null
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.authority === 'foreign') continue
    const record = operation.record
    if (record?.kind !== 'mandate' || !isObject(record.payload) || record.payload.role !== 'epic') continue
    found = { recordId: record.recordId, payload: record.payload }
  }
  return found
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

function fieldsOfIntactMandate(
  payload: Record<string, unknown>,
  epic: number,
): { run: string; base: string; children: EpicChildGrant[] } {
  if (payload.role !== 'epic') throw new Refused(`#${epic} mandate role is ${String(payload.role)}, not epic`)
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`epic #${epic} mandate run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`epic #${epic} mandate base is not a branch name`)
  }
  const children = childGrants(payload.children)
  if (typeof children === 'string') throw new Refused(children)
  return { run: payload.run, base: payload.base, children }
}

function selectedControlTarget(
  history: DecodedHistory,
  external: DecodedHistory[],
  epic: number,
): { mandateId: string; payload: Record<string, unknown>; control: EpicControlState } {
  const selected = selectApplicableMandate(history, external)
  if (selected.status === 'applicable') {
    if (!isObject(selected.mandate.payload)) throw new Refused('epic mandate payload is unreadable')
    const inhibit = localInhibit(history, selected.mandate.recordId)
    const control = inhibit === 'abandon' ? 'abandoned' : inhibit === 'pause' ? 'paused' : 'active'
    return { mandateId: selected.mandate.recordId, payload: selected.mandate.payload, control }
  }
  if (selected.reason === 'paused' || selected.reason === 'abandoned' || selected.reason === 'revoked') {
    const intact = lastIntactEpicMandate(history)
    if (!intact) throw new Refused(`epic #${epic} ${selected.reason} mandate record is not intact`)
    return { mandateId: intact.recordId, payload: intact.payload, control: selected.reason }
  }
  if (selected.reason === 'missing') throw new Assisted(`no confirmed mandate authorizes epic #${epic}`)
  throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
}

function approvedScopes(children: EpicChildGrant[], history: DecodedHistory): Set<string> {
  return new Set([
    ...children.map((child) => `${child.scope.repository}\0${child.scope.target}`),
    ...extensionScopes(history).map((scope) => `${scope.repository}\0${scope.target}`),
  ])
}

/**
 * The intact epic mandate, including when continuation is paused, abandoned, or
 * revoked. Does not switch branches and does not authorize the next step.
 * Callable from Principal: the read is issue history and open PR facts only.
 */
export async function readEpicControlTarget(repo: string, epic: number): Promise<EpicControlTarget> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  const external = await parentMandateHistories(repo, history)
  const target = selectedControlTarget(history, external, epic)
  const fields = fieldsOfIntactMandate(target.payload, epic)
  const { facts } = await gather(repo, epic, fields.run, fields.base, { git: false, dashboard: false, reviews: false })
  const approved = approvedScopes(fields.children, history)
  const openPrs = facts.children.flatMap((child) => {
    const scope = githubScope(full, child.number)
    if (!approved.has(`${scope.repository}\0${scope.target}`)) return []
    return child.prs.filter((pr) => pr.state === 'OPEN').map((pr) => ({ ticket: child.number, pr: pr.number }))
  })
  return {
    epic,
    repository: full,
    mandateId: target.mandateId,
    run: fields.run,
    base: fields.base,
    control: target.control,
    openPrs,
  }
}

/**
 * Disarm open PRs of an authenticated intact mandate, active, paused, abandoned,
 * or revoked. A failed pause publication leaves the remote mandate active; this
 * call still disarms. No branch switch, no hook, no next-step grant, and no
 * pause record. `failed` is not durable pause.
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
  const { facts } = await gather(repo, epic, authority.run, authority.base)
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
