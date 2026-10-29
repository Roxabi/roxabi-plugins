import { canonicalValueDigest, selectorAdmitted } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Result } from '../engine/result.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { priorCorrectionContribution } from './uw-correction-stage-contribution.ts'
import { priorCorrectionDecision } from './uw-correction-stage-decision.ts'
import { cites } from './uw-record-cites.ts'

/** Only populated by the authenticated contribution resolver, never by the command envelope. */
export type VerifiedExpansionRoot = { rootAttemptId: string; negativeRef?: RecordInputRef }

function identityKey(repository: string, target: string, kind: string, recordId: string): string {
  return [repository, target, kind, recordId].join('\0')
}

function field(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

function actionResultSelector(kind: string, selector: string): boolean {
  if (selector === '/payload') return true
  if (kind === 'action-receipt' && (selectorAdmitted('plan', selector) || selectorAdmitted('plan-review', selector)))
    return true
  return selectorAdmitted('implementation', selector) || selectorAdmitted('criterion-evidence', selector)
}

function reviewRecordSelector(kind: string, selector: string): boolean {
  if (selector === '/payload') return true
  if (kind === 'contribution') return selector === '/payload/findings' || /^\/payload\/findings\/\d+$/.test(selector)
  return selector === '/payload/inputSnapshot' || selector.startsWith('/payload/inputSnapshot/')
}

export function knownRoleSelector(kind: string, selector: string): boolean {
  if (selector.includes('/native') || selector.includes('/rawAttempts')) return false
  switch (kind) {
    case 'action-receipt':
    case 'fix-result':
      return actionResultSelector(kind, selector)
    case 'contribution':
    case 'review-attempt':
      return reviewRecordSelector(kind, selector)
    case 'operator-control':
    case 'spec-identity':
    case 'mandate':
    case 'workflow-binding':
    case 'decision':
    case 'review':
    case 'fix-request':
    case 'correction-result':
    case 'falsification-result':
      return selector === '/payload'
    default:
      return false
  }
}

function reviewRoot(record: CanonicalRecord, request: UwActionRequest, reviewedFingerprint?: string): string | null {
  if (record.kind !== 'review-attempt') return null
  const root = field(record.payload, 'rootAttemptId')
  if (root === null) return null
  if (
    request.actionId === root ||
    request.actionId.startsWith(`${root}:`) ||
    (reviewedFingerprint !== undefined && field(record.payload, 'input') === reviewedFingerprint)
  )
    return root
  return null
}

function inventoryIdsOf(record: CanonicalRecord): string[] {
  return Array.isArray((record.payload as { inventoryIds?: unknown }).inventoryIds)
    ? (record.payload as { inventoryIds: unknown[] }).inventoryIds.filter(
        (item): item is string => typeof item === 'string',
      )
    : []
}

function linkedToOwned(
  record: CanonicalRecord,
  roots: ReadonlySet<string>,
  inventories: ReadonlySet<string>,
  owned: readonly CanonicalRecord[],
): boolean {
  const decisionId = field(record.payload, 'decisionId')
  const original = field(record.payload, 'originalContributionId')
  const inventoryIds = inventoryIdsOf(record)
  return (
    roots.has(field(record.payload, 'rootAttemptId') ?? '') ||
    inventories.has(field(record.payload, 'inventoryId') ?? '') ||
    inventories.has(record.recordId) ||
    inventoryIds.some((id) => inventories.has(id)) ||
    (decisionId !== null && owned.some((item) => item.kind === 'decision' && item.recordId === decisionId)) ||
    (original !== null && owned.some((item) => item.kind === 'contribution' && item.recordId === original))
  )
}

function outputKind(kind: string): boolean {
  return (
    kind === 'review' ||
    kind === 'contribution' ||
    kind === 'decision' ||
    kind === 'review-attempt' ||
    kind === 'review-interruption' ||
    kind === 'review-replacement-grant'
  )
}

function ownedOutputs(
  records: readonly CanonicalRecord[],
  roots: ReadonlySet<string>,
  inventories: ReadonlySet<string>,
): Set<string> {
  const outputs = new Set<string>()
  const owned: CanonicalRecord[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const record of records) {
      const key = identityKey(record.repository, record.target, record.kind, record.recordId)
      if (outputs.has(key) || !outputKind(record.kind)) continue
      if (!linkedToOwned(record, roots, inventories, owned)) continue
      owned.push(record)
      outputs.add(key)
      grew = true
    }
  }
  return outputs
}

function refuseOutsideStage(
  request: UwActionRequest,
  outputs: ReadonlySet<string>,
  histories: readonly DecodedHistory[],
): Result<true> {
  for (const ref of request.stageSources) {
    const owned = outputs.has(
      identityKey(ref.record.scope.repository, ref.record.scope.target, ref.record.kind, ref.record.recordId),
    )
    if (request.purpose === 'correction') {
      const prior =
        !owned &&
        (priorCorrectionDecision(ref, request, histories) || priorCorrectionContribution(ref, request, histories))
      if (!prior) return actionFailure('self-output', 'Correction stage source is not an authenticated prior input')
    } else if (!owned) {
      return actionFailure('self-output', 'Stage annex cites a record outside the current root')
    }
  }
  return { ok: true, value: true }
}

function refuseNormativeOutputs(
  request: UwActionRequest,
  normative: readonly RecordInputRef[],
  outputs: ReadonlySet<string>,
): Result<true> {
  for (const ref of [
    ...normative,
    ...request.expandedContext.filter((item): item is RecordInputRef => item.source === 'record'),
  ]) {
    if (!knownRoleSelector(ref.record.kind, ref.selector))
      return actionFailure('record-unreadable', 'Selector is not a known role pointer')
    if (
      outputs.has(
        identityKey(ref.record.scope.repository, ref.record.scope.target, ref.record.kind, ref.record.recordId),
      )
    )
      return actionFailure('self-output', 'Current review output is in normative inputs')
  }
  return { ok: true, value: true }
}

function walkCitations(
  records: readonly CanonicalRecord[],
  outputs: ReadonlySet<string>,
  normative: readonly RecordInputRef[],
  stageSources: readonly RecordInputRef[],
): Result<true> {
  const cited = new Map<string, string[]>()
  for (const record of records) {
    const found = new Set<string>()
    cites(record.payload, found)
    cited.set(record.recordId, [...found])
  }
  const seen = new Set<string>()
  const stack = new Set<string>()
  const visit = (id: string): Result<true> => {
    if (stack.has(id)) return actionFailure('action-input-cycle', 'Input references cycle through current outputs')
    if (seen.has(id)) return { ok: true, value: true }
    seen.add(id)
    stack.add(id)
    for (const next of cited.get(id) ?? []) {
      const output = records.find(
        (record) =>
          record.recordId === next &&
          outputs.has(identityKey(record.repository, record.target, record.kind, record.recordId)),
      )
      if (output !== undefined) return actionFailure('self-output', 'Normative input cites a current review output')
      const stepped = visit(next)
      if (!stepped.ok) return stepped
    }
    stack.delete(id)
    return { ok: true, value: true }
  }
  for (const ref of [...normative, ...stageSources]) {
    const stepped = visit(ref.record.recordId)
    if (!stepped.ok) return stepped
  }
  return { ok: true, value: true }
}

function rootedAttempts(
  records: readonly CanonicalRecord[],
  request: UwActionRequest,
  reviewedFingerprint?: string,
  expansionRoot?: VerifiedExpansionRoot,
): { roots: Set<string>; inventories: Set<string> } {
  const roots = new Set<string>()
  if (expansionRoot !== undefined) roots.add(expansionRoot.rootAttemptId)
  for (const record of records) {
    const root = reviewRoot(record, request, reviewedFingerprint)
    if (root !== null) roots.add(root)
  }
  const inventories = new Set(
    records
      .filter((record) => record.kind === 'review-attempt' && roots.has(field(record.payload, 'rootAttemptId') ?? ''))
      .map((record) => record.recordId),
  )
  return { roots, inventories }
}

export function assertCurrentOutputClosure(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  normative: readonly RecordInputRef[],
  reviewedFingerprint?: string,
  expansionRoot?: VerifiedExpansionRoot,
): Result<true> {
  const records = histories.flatMap((history) => recordsOf(history))
  const { roots, inventories } = rootedAttempts(records, request, reviewedFingerprint, expansionRoot)
  const outputs = ownedOutputs(records, roots, inventories)
  const stage = refuseOutsideStage(request, outputs, histories)
  if (!stage.ok) return stage
  const checkedRequest =
    expansionRoot?.negativeRef === undefined
      ? request
      : {
          ...request,
          expandedContext: request.expandedContext.filter(
            (ref) => canonicalValueDigest(ref) !== canonicalValueDigest(expansionRoot.negativeRef),
          ),
        }
  const normativeOutputs = refuseNormativeOutputs(checkedRequest, normative, outputs)
  if (!normativeOutputs.ok) return normativeOutputs
  return walkCitations(records, outputs, normative, [
    ...request.stageSources,
    ...checkedRequest.expandedContext.filter((item): item is RecordInputRef => item.source === 'record'),
  ])
}

export function currentRootOutputRefs(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  reviewedFingerprint?: string,
  expansionRoot?: VerifiedExpansionRoot,
): RecordInputRef[] {
  const records = histories.flatMap((history) => recordsOf(history))
  const { roots, inventories } = rootedAttempts(records, request, reviewedFingerprint, expansionRoot)
  const outputKeys = ownedOutputs(records, roots, inventories)
  const refs: RecordInputRef[] = []
  for (const record of records) {
    if (!outputKeys.has(identityKey(record.repository, record.target, record.kind, record.recordId))) continue
    if (
      expansionRoot?.negativeRef !== undefined &&
      record.repository === expansionRoot.negativeRef.record.scope.repository &&
      record.target === expansionRoot.negativeRef.record.scope.target &&
      record.kind === expansionRoot.negativeRef.record.kind &&
      record.recordId === expansionRoot.negativeRef.record.recordId
    )
      continue
    refs.push({
      source: 'record',
      record: {
        scope: { repository: record.repository, target: record.target },
        kind: record.kind,
        recordId: record.recordId,
      },
      selector: '/payload',
      digest: '0'.repeat(64),
    })
  }
  return refs
}
