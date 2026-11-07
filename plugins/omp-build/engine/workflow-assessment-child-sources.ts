import type { RecordInputRef } from './action-input-refs.ts'
import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecPrefixes } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import {
  bindExternalRef,
  controlsOf,
  type MandateRecord,
  mandatesOf,
  successorOf,
  workflowOperationProblem,
} from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

export type CapturedAssessmentChildSources = {
  childOwnSources: AssessSpecExact['childOwnSources']
  sourceRefs: readonly ExternalRecordRef[]
}
type ChildSource = { own: AssessSpecExact['childOwnSources'][number]['own']; sourceRefs: readonly ExternalRecordRef[] }

function childHistory(uw: Scope, histories: readonly DecodedHistory[]): DecodedHistory | null {
  const matching = histories.filter((history) => equalScope(history.source.scope, uw))
  const history = matching[0]
  if (
    history === undefined ||
    matching.some((candidate) => canonicalValueDigest(candidate) !== canonicalValueDigest(history)) ||
    workflowOperationProblem(history) !== null
  )
    return null
  return history
}

function matchesCommitment(own: AcceptedOwnSpec, commitment: AcceptedChildCommitment): boolean {
  return (
    own.ref.version === commitment.specVersion &&
    own.tier === commitment.tier &&
    canonicalValueDigest(own.snapshot.spec) === canonicalValueDigest(commitment.snapshot.spec) &&
    own.snapshot.raw.reference === commitment.snapshot.raw.reference &&
    own.snapshot.raw.body === commitment.snapshot.raw.body &&
    own.snapshot.raw.bodySha256 === commitment.snapshot.raw.bodySha256
  )
}

function currentChildSource(
  selected: MandateRecord,
  commitment: AssessSpecExact['proposed']['children'][number] | undefined,
  histories: readonly DecodedHistory[],
  assessmentReplay?: AssessmentReplayContext,
): ChildSource | null {
  const own = resolveAcceptedSpec(selected, histories, assessmentReplay)
  if (!own.ok) return null
  if (commitment === undefined || 'kind' in commitment || !matchesCommitment(own.spec, commitment)) return null
  return { own: own.spec.ref, sourceRefs: own.spec.sourceRefs }
}

function abandonedChildSource(
  uw: Scope,
  history: DecodedHistory,
  mandates: readonly MandateRecord[],
  prior: AcceptedChildCommitment,
  histories: readonly DecodedHistory[],
  assessmentReplay?: AssessmentReplayContext,
): ChildSource | null {
  const candidates = historicalChildCandidates(mandates, prior, histories, assessmentReplay)
  if (candidates === null) return null
  const [candidate] = candidates
  if (candidates.length !== 1 || candidate === undefined) return null
  const { mandate, prefix } = candidate
  const terminals = mandates.filter((entry) => successorOf(history, entry) === null)
  if (terminals.length !== 1 || terminals[0]?.recordId !== mandate.recordId) return null
  const mandateRef: ExternalRecordRef = { scope: uw, recordId: mandate.recordId, kind: 'mandate' }
  const abandoned = controlsOf(history).filter(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, mandateRef),
  )
  const [abandonment] = abandoned
  if (abandoned.length !== 1 || abandonment === undefined) return null
  const control: ExternalRecordRef = { scope: uw, recordId: abandonment.recordId, kind: 'operator-control' }
  if (!bindExternalRef(control, history).ok) return null
  return { own: prefix.ref, sourceRefs: [...prefix.sourceRefs, control] }
}

function captureChildSource(
  uw: Scope,
  accepted: AssessSpecExact['accepted'],
  proposed: AssessSpecExact['proposed'],
  histories: readonly DecodedHistory[],
  attachedChildren: AssessSpecExact['attachedChildren'],
  assessmentReplay?: AssessmentReplayContext,
): ChildSource | null {
  const history = childHistory(uw, histories)
  if (history === null) return null
  const mandates = mandatesOf(history)
  const unresolved = history.operations.some(
    (operation) =>
      (operation.kind === 'mandate' ||
        operation.claimedKinds.includes('mandate') ||
        operation.kind === 'spec-identity' ||
        operation.claimedKinds.includes('spec-identity') ||
        operation.kind === 'operator-control' ||
        operation.claimedKinds.includes('operator-control')) &&
      (operation.authority === 'foreign'
        ? mandates.length === 0
        : operation.status !== 'complete' || operation.record === null),
  )
  if (unresolved) return null
  if (mandates.length === 0) return { own: null, sourceRefs: [] }
  const prior = accepted.children.find((child) => equalScope(child.scope, uw))
  const stillProposed =
    proposed.children.some((child) => !('kind' in child) && equalScope(child.scope, uw)) ||
    attachedChildren.some((child) => equalScope(child.scope, uw))
  const selected = selectedMandate(history)
  if (prior === undefined || stillProposed) {
    if (!('kind' in selected) || selected.kind !== 'mandate') return null
    const commitment =
      prior ??
      proposed.children.find((child) => !('kind' in child) && equalScope(child.scope, uw)) ??
      attachedChildren.find((child) => equalScope(child.scope, uw))
    return currentChildSource(selected, commitment, histories, assessmentReplay)
  }
  if ('kind' in selected || selected.reason !== 'abandoned') return null
  return abandonedChildSource(uw, history, mandates, prior, histories, assessmentReplay)
}

/** Capture current authority or the exact abandoned historical engagement, never inferred absence. */
export function capturedChildOwnSources(
  accepted: AssessSpecExact['accepted'],
  proposed: AssessSpecExact['proposed'],
  histories: readonly DecodedHistory[],
  attachedChildren: AssessSpecExact['attachedChildren'],
  assessmentReplay?: AssessmentReplayContext,
): CapturedAssessmentChildSources | null {
  const scopes = [
    ...accepted.children.map((child) => child.scope),
    ...proposed.children.flatMap((child) => ('kind' in child ? [] : [child.scope])),
    ...attachedChildren.map((child) => child.scope),
  ]
  const childOwnSources: AssessSpecExact['childOwnSources'] = []
  const sourceRefs: ExternalRecordRef[] = []
  for (const uw of scopes) {
    if (childOwnSources.some((entry) => equalScope(entry.uw, uw))) continue
    const source = captureChildSource(uw, accepted, proposed, histories, attachedChildren, assessmentReplay)
    if (source === null) return null
    childOwnSources.push({ uw, own: source.own })
    sourceRefs.push(...source.sourceRefs)
  }
  return { childOwnSources, sourceRefs }
}

export function capturedAssessmentSourcesMatch(
  captured: CapturedAssessmentChildSources,
  pins: readonly RecordInputRef[],
  histories: readonly DecodedHistory[],
): boolean {
  return captured.sourceRefs.every((ref) => {
    const history = histories.find((item) => equalScope(item.source.scope, ref.scope))
    const record = history === undefined ? null : bindExternalRef(ref, history)
    if (record === null || !record.ok) return false
    const matches = pins.filter((pin) => pin.selector === '/payload' && sameRef(pin.record, ref))
    const [match] = matches
    return matches.length === 1 && match !== undefined && match.digest === canonicalValueDigest(record.value.payload)
  })
}

function historicalChildCandidates(
  mandates: readonly MandateRecord[],
  prior: AcceptedChildCommitment,
  histories: readonly DecodedHistory[],
  assessmentReplay?: AssessmentReplayContext,
): { mandate: MandateRecord; prefix: AcceptedOwnSpec }[] | null {
  const candidates: { mandate: MandateRecord; prefix: AcceptedOwnSpec }[] = []
  for (const mandate of mandates) {
    const prefixes = resolveAcceptedSpecPrefixes(mandate, histories, assessmentReplay)
    if (!prefixes.ok) return null
    for (const prefix of prefixes.prefixes) {
      if (!matchesCommitment(prefix, prior)) continue
      const last = prefix.chain.at(-1)
      if (last !== undefined && sameRef(last.source, prefix.ref.sourceAccepted)) candidates.push({ mandate, prefix })
    }
  }
  return candidates
}
