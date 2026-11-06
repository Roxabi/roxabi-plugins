import { canonicalValueDigest } from './action-input.ts'
import {
  currentDecision,
  effectTarget,
  fail,
  type Input,
  replacementCycles,
} from './cause-dependency-adjustment-decision.ts'
import { inventory, native } from './cause-dependency-adjustment-observation.ts'
import {
  causeDependencyAdjustmentProposalSchema,
  type PreparedCauseDependencyAdjustment,
} from './cause-dependency-adjustment-schema.ts'
import { causeAdjustmentExpectedEffect, causeAdjustmentReferencesValid } from './cause-dependency-control.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import { resolveSpecEffectiveForControl } from './spec-effective.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'
import { projectUwWaits } from './uw-waits.ts'
import { historyFor, recordsOf } from './workflow-control.ts'
import { resolveOwnSpecAuthority } from './workflow-mandate-admission.ts'

function authenticatedAdjustmentReferences(input: Input, history: DecodedHistory): boolean {
  const disposition = recordsOf(history).find(
    (record) => record.kind === 'cause-disposition' && record.recordId === input.disposition.recordId,
  )
  return (
    disposition?.kind === 'cause-disposition' &&
    causeAdjustmentReferencesValid(input.references, disposition, input.observation.histories)
  )
}

/** Build a decision only from the current complete factual observation and authenticated wait chain. */
export function prepareCauseDependencyAdjustment(input: Input): UwResult<PreparedCauseDependencyAdjustment> {
  const { origin, observation } = input
  if (observation.status !== 'complete' || !equalScope(observation.graph.root, origin))
    return fail(origin, 'A complete origin-rooted native and workflow observation is required')
  const captured = inventory(observation)
  const history = historyFor(origin, observation.histories)
  const node = observation.graph.nodes.find((entry) => equalScope(entry.uw, origin))
  const before = node === undefined ? null : native(node)
  if (!captured || !history || !before) return fail(origin, 'Origin facts or unique complete histories are unavailable')
  const authority = resolveOwnSpecAuthority(
    history,
    observation.histories.filter((item) => item !== history),
    { histories: observation.histories, catalogues: observation.catalogues, observation },
  )
  if (!authority.ok) return fail(origin, 'Active current mandate and accepted Spec cannot be authenticated')
  const selected = authority.value.mandate
  const accepted = { ok: true as const, spec: authority.value.accepted }
  const effective = resolveSpecEffectiveForControl({
    mode: 'current',
    own: accepted.spec.ref,
    histories: observation.histories,
    graph: observation.graph,
  })
  if (!effective.ok) return effective
  if (!authenticatedAdjustmentReferences(input, history))
    return fail(origin, 'A decision reference cannot be authenticated')
  const waits = projectUwWaits({
    graph: observation.graph,
    histories: observation.histories,
    catalogues: observation.catalogues,
  })
  const decision = currentDecision(input, history, waits)
  if (!decision.ok) return decision
  const { predecessor, target } = decision.value
  if (input.change.kind === 'replace') {
    const blocker = input.change.blocker
    if (!observation.graph.nodes.some((entry) => equalScope(entry.uw, blocker)))
      return fail(origin, 'Replacement facts were not included in the native observation')
  }
  const parsed = causeDependencyAdjustmentProposalSchema.safeParse({
    format: 'omp-build-cause-dependency-adjustment/1',
    operationId: input.operationId,
    controlId: input.controlId,
    origin,
    mandate: { scope: origin, recordId: selected.recordId, kind: 'mandate' },
    accepted: accepted.spec.ref,
    versionVector: effective.value.versionVector,
    disposition: input.disposition,
    receipt: input.receipt,
    predecessor,
    change: input.change,
    reason: input.reason,
    references: input.references,
    before,
    nativeObservationDigest: nativeObservationDigest(before),
    histories: captured.histories,
    nativeGraph: captured.nativeGraph,
    nativeEffect: input.nativeEffect,
  })
  if (!parsed.success || causeAdjustmentExpectedEffect(parsed.data, target) === null)
    return fail(origin, 'The proposal or explicit native blocker delta is invalid')
  const cycles = replacementCycles(input, waits)
  if (cycles.length) return { ok: false, diagnostics: cycles }
  return { ok: true, value: { proposal: parsed.data, digest: canonicalValueDigest(parsed.data) } }
}

export function recheckCauseDependencyAdjustment(
  prepared: PreparedCauseDependencyAdjustment,
  observation: UwCompletionObservation,
): UwResult<PreparedCauseDependencyAdjustment> {
  const p = prepared.proposal
  const checked = prepareCauseDependencyAdjustment({
    operationId: p.operationId,
    controlId: p.controlId,
    origin: p.origin,
    disposition: p.disposition,
    receipt: p.receipt,
    predecessor: p.predecessor,
    change: p.change,
    nativeEffect: p.nativeEffect,
    reason: p.reason,
    references: p.references,
    observation,
  })
  if (!checked.ok) return checked
  const normalized = {
    ...checked.value.proposal,
    before: { ...checked.value.proposal.before, updatedAt: p.before.updatedAt },
  }
  return prepared.digest === canonicalValueDigest(p) && canonicalValueDigest(normalized) === prepared.digest
    ? { ok: true, value: prepared }
    : fail(p.origin, 'Facts or authority changed after confirmation')
}

/** Recheck fresh post-effect facts while subtracting only the sealed effect of this invocation. */
export function recheckCauseDependencyAdjustmentEffect(
  prepared: PreparedCauseDependencyAdjustment,
  observed: NativeIssueObservation,
  observation: UwCompletionObservation,
): UwResult<PreparedCauseDependencyAdjustment> {
  const p = prepared.proposal
  if (observation.status !== 'complete') return fail(p.origin, 'Post-effect observation is incomplete')
  const node = observation.graph.nodes.find((entry) => equalScope(entry.uw, p.origin))
  const actual = node && native(node)
  if (!actual || nativeObservationDigest(actual) !== nativeObservationDigest(observed))
    return fail(p.origin, 'Writer and fresh native readback disagree')
  const scope = (ref: NativeIssueObservation['issue']): Scope => ({
    repository: ref.repository,
    target: `${ref.repository}#${ref.number}`,
  })
  const before = p.before
  const baseline: UwCompletionObservation = {
    ...observation,
    graph: {
      ...observation.graph,
      nodes: observation.graph.nodes.map((entry) =>
        equalScope(entry.uw, p.origin) ? { ...entry, blockers: before.blockers.map(scope) } : entry,
      ),
    },
  }
  const checked = recheckCauseDependencyAdjustment(prepared, baseline)
  if (!checked.ok) return checked
  const target = effectTarget(p, baseline)
  if (!target.ok) return target
  const expected = causeAdjustmentExpectedEffect(p, target.value)
  return expected !== null && nativeObservationDigest(expected) === nativeObservationDigest(actual)
    ? checked
    : fail(p.origin, 'Native result exceeds the confirmed blocker delta')
}
