import type { Gh } from '../../adapters/github/types.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import type { CriterionDeclaration } from '../criterion-evidence-schema.ts'
import { type CriterionVerdict, criterionVerdictSchema } from '../criterion-verdict-schema.ts'
import type { CriterionTarget } from '../finding-target-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective-schema.ts'
import {
  type MandateRecord,
  mandateScope,
  type ReceiptRecord,
  recordsOf,
  workflowOperationProblem,
} from '../workflow-control.ts'
import { syncNativeHistories } from './same-pr-history-sync.ts'
import { attachReviewInputs } from './same-pr-review-attachment.ts'

export async function syncSamePrHistories(cwd: string, gh: Gh, histories: readonly DecodedHistory[]) {
  await syncNativeHistories(cwd, gh, histories)
}

type ImplementResult = Extract<CanonicalRecord, { kind: 'action-receipt' }> & {
  payload: Extract<
    Extract<CanonicalRecord, { kind: 'action-receipt' }>['payload'],
    { action: 'implement'; phase: 'result' }
  >
}

function isImplementResult(record: CanonicalRecord): record is ImplementResult {
  return record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result'
}

export interface SamePrCriterionFixtureOptions {
  mandate: MandateRecord
  effective: SpecEffective
  binding: CanonicalRecord
  pullRequest: Scope
  head: string
  prefix: string
  produce: () => Promise<{ records: CanonicalRecord[]; history: DecodedHistory; reviewInputs: ActionInputs }>
}

export interface SamePrCriterionFixture {
  inputs: ActionInputs
  planRecords: CanonicalRecord[]
  implementationStart: ReceiptRecord
  implementationResult: ImplementResult
  authorityRecords: CanonicalRecord[]
  authorityHistory: DecodedHistory
  target: CriterionTarget
  declaration: CriterionDeclaration
  verdict: CriterionVerdict
  specRows: CriterionVerdict[]
}

/** The caller produces native records and prepares review inputs in its declared world. */
export async function createSamePrCriterionFixture(
  options: SamePrCriterionFixtureOptions,
): Promise<SamePrCriterionFixture> {
  const { mandate, effective, binding, pullRequest, head } = options
  const uw = mandateScope(mandate)
  const own = effective.own
  if (canonicalValueDigest(own.uw) !== canonicalValueDigest(uw))
    throw new Error('effective Spec must belong to the execution mandate UW')
  if (!effective.spec.criteria.some((criterion) => criterion.id === 'C1'))
    throw new Error('effective Spec must contain C1')
  if (binding.repository !== pullRequest.repository || binding.target !== pullRequest.target)
    throw new Error('binding must belong to the supplied pull request')

  const produced = await options.produce()
  function authenticateReadback() {
    if (
      !produced.history.source.complete ||
      workflowOperationProblem(produced.history) !== null ||
      canonicalValueDigest(produced.history.source.scope) !== canonicalValueDigest(uw)
    )
      throw new Error('Expected complete native implementation readback')
    const observedRecords = recordsOf(produced.history)
    for (const record of produced.records) {
      const observed = observedRecords.find((item) => item.recordId === record.recordId)
      if (!observed || canonicalValueDigest(observed) !== canonicalValueDigest(record))
        throw new Error(`Native readback does not authenticate ${record.recordId}`)
    }
  }
  authenticateReadback()
  function authenticateImplementation() {
    const implementationResults = produced.records.filter(
      (record): record is ImplementResult =>
        isImplementResult(record) &&
        record.payload.admission?.admitted === true &&
        record.payload.structured?.outcome === 'implemented' &&
        record.payload.admission.remoteTip === head &&
        canonicalValueDigest(record.payload.inputs.manifest.spec) ===
          canonicalValueDigest({ kind: 'accepted', effective }),
    )
    const implementationResult = implementationResults[0]
    if (
      implementationResults.length !== 1 ||
      implementationResult?.kind !== 'action-receipt' ||
      implementationResult.payload.action !== 'implement' ||
      implementationResult.payload.phase !== 'result' ||
      implementationResult.payload.structured?.outcome !== 'implemented'
    )
      throw new Error('Expected a native admitted implementation result at the observed head')
    const implementationStart = produced.records.find(
      (record) => record.kind === 'action-receipt' && record.recordId === implementationResult.payload.start.recordId,
    )
    if (
      implementationStart?.kind !== 'action-receipt' ||
      implementationStart.payload.action !== 'implement' ||
      implementationStart.payload.phase !== 'start' ||
      implementationStart.repository !== implementationResult.repository ||
      implementationStart.target !== implementationResult.target ||
      implementationStart.payload.actionId !== implementationResult.payload.actionId ||
      canonicalValueDigest(implementationStart.payload.inputs) !==
        canonicalValueDigest(implementationResult.payload.inputs) ||
      canonicalValueDigest(implementationStart.payload.exactInputs) !==
        canonicalValueDigest(implementationResult.payload.exactInputs) ||
      canonicalValueDigest(implementationStart.payload.mandate) !==
        canonicalValueDigest(implementationResult.payload.mandate)
    )
      throw new Error('Expected the paired native implementation START')
    if (
      canonicalValueDigest(implementationResult.payload.inputs.manifest.spec) !==
      canonicalValueDigest({ kind: 'accepted', effective })
    )
      throw new Error('Native implementation does not bind the supplied effective Spec')
    const declaration = implementationResult.payload.structured.criteria[0]
    if (
      declaration?.verification !== 'unverified' ||
      declaration.target.id !== 'C1' ||
      canonicalValueDigest(declaration.target.spec) !== canonicalValueDigest(own)
    )
      throw new Error('Expected the native unverified C1 declaration')
    return { implementationStart, implementationResult, declaration }
  }
  const { implementationStart, implementationResult, declaration } = authenticateImplementation()
  const target = declaration.target
  const reason = declaration.reason
  const planRecords = produced.records.filter(
    (record) =>
      record.recordId !== mandate.recordId &&
      record.recordId !== implementationStart.recordId &&
      record.recordId !== implementationResult.recordId,
  )
  const verdict = criterionVerdictSchema.parse({
    target,
    verdict: 'unverified',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [],
    reason,
  })
  const inputs = produced.reviewInputs
  const subject = inputs.manifest.subject
  const selections = inputs.manifest.deliveryData.filter(
    (entry) =>
      entry.role === 'implementation' &&
      entry.record.recordId === implementationResult.recordId &&
      entry.selector === '/payload/structured/criteria/0',
  )
  const selection = selections[0]
  if (
    inputs.fingerprint !== actionInputDigest(inputs.manifest) ||
    subject.kind !== 'uw' ||
    canonicalValueDigest(subject.uw) !== canonicalValueDigest(uw) ||
    canonicalValueDigest(subject.pullRequest) !== canonicalValueDigest(pullRequest) ||
    subject.binding?.record.recordId !== binding.recordId ||
    subject.binding.selector !== '/payload' ||
    subject.binding.digest !== canonicalValueDigest(binding.payload) ||
    subject.binding.record.kind !== binding.kind ||
    canonicalValueDigest(subject.binding.record.scope) !== canonicalValueDigest(pullRequest) ||
    inputs.manifest.code.head !== head ||
    canonicalValueDigest(inputs.manifest.spec) !== canonicalValueDigest({ kind: 'accepted', effective }) ||
    selections.length !== 1 ||
    selection?.record.recordId !== implementationResult.recordId ||
    selection.record.kind !== 'action-receipt' ||
    canonicalValueDigest(selection.record.scope) !== canonicalValueDigest(uw) ||
    selection.selector !== '/payload/structured/criteria/0' ||
    selection.digest !== canonicalValueDigest(declaration)
  )
    throw new Error('Review inputs do not bind the produced same-PR implementation')
  return {
    inputs,
    planRecords,
    implementationStart,
    implementationResult,
    authorityRecords: [...planRecords, implementationStart, implementationResult],
    authorityHistory: produced.history,
    target,
    declaration,
    verdict,
    specRows: [verdict],
  }
}

export function attachSamePrCriterionReview(
  history: DecodedHistory,
  reviewId: string,
  inputs: ActionInputs,
  verdict: CriterionVerdict,
): DecodedHistory {
  return attachReviewInputs(history, reviewId, inputs, verdict)
}
