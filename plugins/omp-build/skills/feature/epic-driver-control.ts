import { type DecodedHistory, resolveAcceptedSpec, selectApplicableMandate } from '../../dist/contracts.js'
import type { MandateRecord } from '../../engine/workflow-control.ts'
import type { WorkflowCausalContext } from '../../engine/workflow-plan.ts'
import { readFreshUwCausalContext } from '../../roxabi/fix-uw-histories.ts'
import { confirmedEpicMandate, evidenceText } from './epic-driver-authority'
import { discoverAcceptedChildPrs, discoverOwnPrs } from './epic-driver-containment'
import { adapterOptions, issueHistory, parentMandateHistories, repoName } from './epic-driver-github'
import { Assisted, Refused } from './epic-driver-runtime'

export type EpicControlState = 'active' | 'abandoned' | 'revoked'

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

function selectedControlTarget(
  history: DecodedHistory,
  external: DecodedHistory[],
  causal: WorkflowCausalContext,
  epic: number,
): { mandate: MandateRecord; control: EpicControlState } {
  const selected = selectApplicableMandate(history, external, causal)
  if (selected.status === 'applicable') return { mandate: selected.mandate, control: 'active' }
  if (selected.reason === 'abandoned' || selected.reason === 'revoked') {
    const mandate = namedTerminalMandate(history, selected.reason)
    if (mandate === null) throw new Refused(`epic #${epic} ${selected.reason} mandate record is not intact`)
    return { mandate, control: selected.reason }
  }
  if (selected.reason === 'missing') throw new Assisted(`no confirmed mandate authorizes epic #${epic}`)
  throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
}

/**
 * The intact normal mandate, including when abandoned or revoked. It reads
 * the authenticated child projection but does not authorize delivery or branch switching.
 */
export async function readEpicControlTarget(repo: string, epic: number): Promise<EpicControlTarget> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  const external = await parentMandateHistories(repo, history)
  const causal = await readFreshUwCausalContext(history.source.scope, [history, ...external], adapterOptions(repo))
  if (!causal.ok) throw new Refused(`epic causal history unavailable: ${causal.diagnostics.join(',')}`)
  const target = selectedControlTarget(history, external, causal.value, epic)
  const accepted = resolveAcceptedSpec(target.mandate, causal.value.histories)
  if (!accepted.ok) {
    throw new Refused(`epic parent accepted Spec ${accepted.reason}: ${evidenceText(accepted.evidence)}`)
  }
  const fields = confirmedEpicMandate(target.mandate, accepted.spec)
  const own = await discoverOwnPrs(repo, full, epic, target.mandate, history.source.scope)
  const children = await discoverAcceptedChildPrs(repo, full, epic, fields.mandateId, fields.children)
  const inventory = new Map<number, { ticket: number; pr: number }>()
  for (const item of [...own, ...children]) {
    const prior = inventory.get(item.pr)
    if (prior && prior.ticket !== item.ticket) throw new Refused(`containment PR #${item.pr} has conflicting owners`)
    inventory.set(item.pr, item)
  }
  const openPrs = [...inventory.values()]
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
