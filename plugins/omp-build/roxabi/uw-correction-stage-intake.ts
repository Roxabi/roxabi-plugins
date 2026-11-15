import { canonicalValueDigest, resolveCorrectionRootBasis } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { CorrectionStageContext } from './uw-action-closure.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

/** Authenticate one initial intake output and the complete root-bound source set. */
export function requestAnchoredIntake(
  entry: Contribution,
  inventory: Inventory,
  request: UwActionRequest,
  stage: CorrectionStageContext,
  history: DecodedHistory,
  records: readonly CanonicalRecord[],
): boolean {
  const root = stage.correctionRoot
  const slot = inventory.payload.slots.find((item) => item.slotId === entry.payload.host.slotId)
  const binding = slot?.action
  if (
    root === null ||
    root.inventory.kind !== 'review-attempt' ||
    root.inventory.scope.repository !== inventory.repository ||
    root.inventory.scope.target !== inventory.target ||
    root.inventory.recordId !== inventory.recordId ||
    inventory.payload.purpose !== 'correction' ||
    inventory.payload.stage !== 'initial' ||
    root.requestId !== inventory.payload.requestId ||
    inventory.payload.rootAttemptId !== inventory.recordId ||
    slot?.phase !== 'intake' ||
    slot.output !== 'findings' ||
    entry.payload.content !== 'findings' ||
    binding === undefined ||
    !matchesRequestedSubject(binding.inputs.manifest.subject, stage.subject) ||
    request.code.head !== inventory.payload.candidateGitSHA
  )
    return false
  const fixes = records.filter((record) => record.kind === 'fix-request' && record.recordId === root.requestId)
  const fix = fixes[0]
  if (
    fixes.length !== 1 ||
    fix?.kind !== 'fix-request' ||
    !inventory.inputs.includes(fix.recordId) ||
    fix.payload.existingReviewId !== null
  )
    return false
  const basis = resolveCorrectionRootBasis(history, fix)
  if (!basis.ok || basis.value.originalCandidate !== inventory.payload.candidateGitSHA) return false
  const prior = binding.inputs.stageSources.map(canonicalValueDigest).sort()
  const carried = request.stageSources
    .filter((ref) => ref.record.kind !== 'contribution')
    .map(canonicalValueDigest)
    .sort()
  if (canonicalValueDigest(prior) !== canonicalValueDigest(carried)) return false
  const refs = request.stageSources.filter((ref) => ref.record.kind === 'contribution')
  const expected = records.filter((record): record is Contribution => {
    if (record.kind !== 'contribution' || record.payload.content !== 'findings' || record.payload.inventoryId === null)
      return false
    const owner = records.find((item) => item.kind === 'review-attempt' && item.recordId === record.payload.inventoryId)
    return owner?.kind === 'review-attempt' && owner.payload.rootAttemptId === root.inventory.recordId
  })
  if (refs.length !== expected.length) return false
  const identities = new Set<string>()
  for (const ref of refs) {
    const matches = expected.filter((item) => item.recordId === ref.record.recordId)
    const item = matches[0]
    if (
      matches.length !== 1 ||
      item === undefined ||
      item.payload.inventoryId !== root.inventory.recordId ||
      ref.selector !== '/payload' ||
      ref.record.scope.repository !== inventory.repository ||
      ref.record.scope.target !== inventory.target ||
      ref.digest !== canonicalValueDigest(item.payload) ||
      identities.has(item.recordId)
    )
      return false
    identities.add(item.recordId)
  }
  return true
}
