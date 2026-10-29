import { describe, expect, test } from 'vitest'
import { acceptedActionInputs, standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, reviewRoot, TEST_HEAD } from '../../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../../testing/record-decisions.ts'
import { history, observedComment, operation } from '../../testing/record-history.ts'
import {
  admittedImplement,
  eligiblePlan,
  shippedMandate,
} from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { DeliveryDataRef } from '../action-input-schema.ts'
import { recordInputRefSchema } from '../action-input-schema.ts'
import { criterionAssessmentForDecision } from '../criterion-decision.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import { criterionEvidenceSchema } from '../criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../criterion-verdict-schema.ts'
import { validateProspectiveRecord } from '../history-graph.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Diagnostic } from '../record-values.ts'
import { validateDecision } from '../review-decision.ts'
import { reviewCandidateCode } from '../review-inventory-input.ts'
import { bindExternalRef, type MandateRecord, mandateScope, type ReceiptRecord } from '../workflow-control.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { evidenceDeclaration, passingTest } from './criterion-admission-fixture.ts'
import { binding } from './workflow-test-support.ts'

type PlanResult = ReceiptRecord & {
  payload: Extract<ActionReceiptPayload, { action: 'plan'; phase: 'result' }>
}
type ImplementResult = ReceiptRecord & {
  payload: Extract<ActionReceiptPayload, { action: 'implement'; phase: 'result' }>
}

function codes(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((item) => item.code)
}

function isPlanResult(record: CanonicalRecord): record is PlanResult {
  return record.kind === 'action-receipt' && record.payload.action === 'plan' && record.payload.phase === 'result'
}

function isImplementResult(record: CanonicalRecord): record is ImplementResult {
  return record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result'
}

function scoped(records: readonly CanonicalRecord[], mandate: MandateRecord): DecodedHistory {
  const observed = history([...records])
  return { ...observed, source: { ...observed.source, scope: mandateScope(mandate), expectedAuthor: NATIVE_AUTHOR } }
}

function boundReview(mandate: MandateRecord) {
  const inputs = acceptedActionInputs(mandate, 'review')
  const uw = mandateScope(mandate)
  const pullRequest = { repository: uw.repository, target: `${uw.repository}#999` }
  const record = binding(mandate, pullRequest)
  const pin = (item: CanonicalRecord) => ({
    source: 'record' as const,
    record: { scope: { repository: item.repository, target: item.target }, kind: item.kind, recordId: item.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(item.payload),
  })
  const manifest = {
    ...inputs.manifest,
    subject: { kind: 'uw' as const, uw, pullRequest, binding: pin(record) },
    acceptedSources: [pin(mandate)],
  }
  const bound = { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const observed = history([record])
  return {
    inputs: bound,
    bindingHistory: { ...observed, source: { ...observed.source, scope: pullRequest } },
  }
}

function planResult(mandate: MandateRecord): PlanResult {
  const found = eligiblePlan(mandate).find(isPlanResult)
  if (found === undefined) throw new Error('produced plan result missing')
  return found
}

function refFor(
  record: ReceiptRecord,
  role: DeliveryDataRef['role'],
  selector: string,
  value: unknown,
): DeliveryDataRef {
  return {
    source: 'record',
    role,
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: 'action-receipt',
    },
    selector,
    digest: canonicalValueDigest(value),
  }
}

function headedImplement(receipt: ImplementResult, head: string): ImplementResult {
  if (receipt.payload.admission === null) throw new Error('implement admission missing')
  return {
    ...receipt,
    payload: {
      ...receipt.payload,
      admission: { ...receipt.payload.admission, admitted: true, remoteTip: head },
    },
  }
}

function implementStart(result: ImplementResult): ReceiptRecord {
  return {
    ...result,
    recordId: `${result.recordId}-start`,
    operationId: `${result.operationId}-start`,
    payload: {
      format: result.payload.format,
      phase: 'start',
      action: 'implement',
      actionId: result.payload.actionId,
      mandate: result.payload.mandate,
      inputs: result.payload.inputs,
      exactInputs: result.payload.exactInputs,
    },
  }
}

describe('authorized criterion delivery admission', () => {
  test('keeps a produced plan with a null admission eligible', () => {
    const mandate = shippedMandate()
    const plan = planResult(mandate)
    const bound = boundReview(mandate)
    expect(plan.payload.admission).toBeNull()
    const diagnostics: Diagnostic[] = []
    selectedDeclarations(
      [scoped([mandate, ...eligiblePlan(mandate)], mandate), bound.bindingHistory],
      {
        ...bound.inputs,
        manifest: {
          ...bound.inputs.manifest,
          deliveryData: [refFor(plan, 'plan', '/payload/structured', plan.payload.structured)],
        },
      },
      diagnostics,
    )
    expect(codes(diagnostics)).not.toEqual(expect.arrayContaining(['unconfirmed', 'ambiguous']))
  })

  test('refuses a prospective decision or review with dangling links', () => {
    const dangling = decision({
      id: 'prospective-decision',
      inputs: [],
      originalContributionId: 'missing-contribution',
      sourceContributionIds: [],
      findings: [],
    })
    const review = finalReview({
      id: 'prospective-review',
      inputs: [],
      decisionId: 'missing-decision',
      inventoryIds: [],
    })
    expect(validateProspectiveRecord(dangling, history([])).length).toBeGreaterThan(0)
    expect(validateProspectiveRecord(review, history([])).length).toBeGreaterThan(0)
  })

  test('refuses an implementation start from another mandate', () => {
    const current = shippedMandate()
    const old = { ...current, recordId: 'mandate-old' }
    const plan = planResult(current)
    const bound = boundReview(current)
    const inputs = bound.inputs
    const receipt = admittedImplement(old)
    if (!isImplementResult(receipt)) throw new Error('implement shape')
    const headed = headedImplement(receipt, inputs.manifest.code.head)
    const start = implementStart(headed)
    const diagnostics: Diagnostic[] = []
    selectedDeclarations(
      [scoped([current, plan, start, headed], current), bound.bindingHistory],
      {
        ...inputs,
        manifest: {
          ...inputs.manifest,
          deliveryData: [refFor(headed, 'implementation', '/payload/structured', headed.payload.structured)],
        },
      },
      diagnostics,
    )
    expect(codes(diagnostics)).toContain('unconfirmed')
  })

  test('refuses a forged external author and a mismatched operation id', () => {
    const mandate = shippedMandate()
    const receipt = admittedImplement(mandate)
    const authored = operation(receipt, {
      parts: [observedComment({ locator: 'forged-author', nativeId: '101', author: 'forger' })],
    })
    const mismatched = { ...operation(receipt), operationId: 'forged-op' }
    const authorHistory = scoped([], mandate)
    authorHistory.operations = [authored]
    const metaHistory = scoped([], mandate)
    metaHistory.operations = [mismatched]
    const ref = { scope: mandateScope(mandate), recordId: receipt.recordId, kind: 'action-receipt' as const }
    expect(bindExternalRef(ref, authorHistory).ok).toBe(false)
    expect(bindExternalRef(ref, metaHistory).ok).toBe(false)
  })

  test('does not approve candidate A when the stored standalone manifest hashes B', () => {
    const aligned = standaloneReviewInputs()
    const manifest = { ...aligned.manifest, code: { ...aligned.manifest.code, head: 'b'.repeat(40) } }
    const stored = { ...aligned, manifest, fingerprint: actionInputDigest(manifest) }
    const root = reviewRoot({ id: 'standalone-root', head: TEST_HEAD, inputSnapshot: stored })
    if (!('inputSnapshot' in root.payload)) throw new Error('expected review inventory snapshot')
    const source = contribution({
      id: 'standalone-source',
      inventoryId: root.recordId,
      inputs: [root.recordId],
      findings: [],
    })
    const verdict = decision({
      id: 'standalone-decision',
      inputs: [source.recordId],
      sourceContributionIds: [source.recordId],
      originalContributionId: source.recordId,
      findings: [],
    })
    if (verdict.payload.judgment.purpose !== 'review') throw new Error('expected a review decision')
    const observed = history([root, source, verdict])
    const code = reviewCandidateCode(verdict.payload.judgment, observed)
    const assessment = criterionAssessmentForDecision(
      verdict.payload.judgment,
      stored,
      { declarations: [], evidence: [], verdicts: [], diagnostics: [] },
      code,
    )
    const admitted = validateDecision(verdict, observed, [], null)
    expect(root.payload.candidateGitSHA).toBe(TEST_HEAD)
    expect(stored.manifest.code.head).toBe('b'.repeat(40))
    expect(root.payload.inputSnapshot?.fingerprint).toBe(stored.fingerprint)
    expect(code).toBeNull()
    expect(assessment.forceRequestChanges).toBe(true)
    expect(codes(assessment.diagnostics)).toContain('mismatch')
    expect(admitted.verdict).not.toBe('Approve')
    expect(admitted.verdict).not.toBe('Approve (clean)')
    expect(admitted.verdict).not.toBe('Approve with comments')
  })

  test('refuses unresolved version-claim and code-link references before admission', () => {
    const mandate = shippedMandate()
    const bound = boundReview(mandate)
    const inputs = bound.inputs
    if (inputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted spec')
    const head = inputs.manifest.code.head
    const plan = planResult(mandate)
    const base = passingTest('C1')
    if (base.method !== 'test') throw new Error('expected test evidence')
    const receipt = admittedImplement(mandate)
    if (!isImplementResult(receipt) || receipt.payload.structured === null)
      throw new Error('expected an implementation result')
    const aligned = criterionEvidenceSchema.parse({
      ...base,
      provenance: { ...base.provenance, actionId: receipt.payload.actionId },
      target: { ...base.target, spec: inputs.manifest.spec.effective.own },
      code: { repository: mandate.payload.ownSpec.uw.repository, commit: head },
      after: {
        ...base.after,
        versionClaim: {
          ...base.after.versionClaim,
          code: { repository: mandate.payload.ownSpec.uw.repository, commit: head },
          references: [],
        },
      },
    })
    if (aligned.method !== 'test') throw new Error('expected test evidence')
    const structured = receipt.payload.structured
    const withCriteria = (evidence: typeof aligned): ImplementResult =>
      headedImplement(
        {
          ...receipt,
          payload: {
            ...receipt.payload,
            structured: { ...structured, criteria: [evidenceDeclaration(evidence)] },
            native: {
              ...receipt.payload.native,
              bashCalls: [
                {
                  toolCallId: aligned.after.run.toolCallId,
                  input: { command: aligned.after.run.command },
                  effectiveCwd: aligned.after.run.context.probeCwd,
                  result: { output: 'PASS selected region survived reload' },
                  exitCode: aligned.after.run.exitCode,
                },
              ],
            },
          },
        },
        head,
      )
    const missing = recordInputRefSchema.parse({
      source: 'record',
      record: { scope: mandateScope(mandate), kind: 'contribution', recordId: 'missing-link' },
      selector: '/recordId',
      digest: canonicalValueDigest('missing-link'),
    })
    const clearReceipt = withCriteria(aligned)
    const clearDiagnostics: Diagnostic[] = []
    selectedDeclarations(
      [scoped([mandate, plan, implementStart(clearReceipt), clearReceipt], mandate), bound.bindingHistory],
      {
        ...inputs,
        manifest: {
          ...inputs.manifest,
          deliveryData: [
            refFor(clearReceipt, 'implementation', '/payload/structured', clearReceipt.payload.structured),
          ],
        },
      },
      clearDiagnostics,
    )
    const unresolved = criterionEvidenceSchema.parse({
      ...aligned,
      after: { ...aligned.after, versionClaim: { ...aligned.after.versionClaim, references: [missing] } },
    })
    if (unresolved.method !== 'test') throw new Error('expected test evidence')
    const refusedReceipt = withCriteria(unresolved)
    const refusedDiagnostics: Diagnostic[] = []
    selectedDeclarations(
      [scoped([mandate, plan, implementStart(refusedReceipt), refusedReceipt], mandate), bound.bindingHistory],
      {
        ...inputs,
        manifest: {
          ...inputs.manifest,
          deliveryData: [
            refFor(refusedReceipt, 'implementation', '/payload/structured', refusedReceipt.payload.structured),
          ],
        },
      },
      refusedDiagnostics,
    )
    const stored = criterionVerdictSchema.parse({
      target: aligned.target,
      verdict: 'satisfied',
      criterionKind: 'behavior',
      bugRegression: false,
      restoration: 'not-applicable',
      examined: [
        {
          evidence: {
            receipt: { scope: mandateScope(mandate), kind: 'action-receipt', recordId: receipt.recordId },
            evidenceId: aligned.id,
            digest: canonicalValueDigest(aligned),
          },
          truth: 'supported',
          applicability: 'applies',
          codeLink: {
            method: 'observation',
            current: { support: 'unknown', reason: 'stored reference', references: [missing] },
          },
          reason: 'stored reference is unresolved',
        },
      ],
      reason: 'stored code link',
    })
    const spec = contribution({
      id: 'stored-verdict',
      inventoryId: 'root-review',
      content: 'findings',
      findings: [],
      role: 'R-review-spec',
      structured: stored,
    })
    const verdict = decision({
      id: 'stored-decision',
      purpose: 'review',
      inputs: [spec.recordId],
      originalContributionId: spec.recordId,
      sourceContributionIds: [spec.recordId],
      findings: [],
    })
    if (verdict.payload.judgment.purpose !== 'review') throw new Error('expected a review decision')
    const linked = {
      ...verdict,
      payload: {
        ...verdict.payload,
        judgment: {
          ...verdict.payload.judgment,
          criterionVerdicts: [{ contributionId: spec.recordId, target: aligned.target }],
        },
      },
    }
    const graph = scoped([spec, linked], mandate)
    const examined = stored.examined[0]
    if (examined === undefined) throw new Error('expected examined evidence')
    const assessed = criterionAssessmentForDecision(
      linked.payload.judgment,
      inputs,
      {
        declarations: [evidenceDeclaration(aligned)],
        evidence: [{ ref: examined.evidence, value: aligned }],
        verdicts: [stored],
        diagnostics: [],
      },
      { repository: inputs.manifest.code.repository, commit: head },
      [graph],
    )
    expect(clearDiagnostics).toEqual([])
    expect(codes(refusedDiagnostics)).toContain('unknown')
    expect(refusedDiagnostics.map((item) => item.message).join('\n')).toContain('missing-link')
    expect(assessed.forceRequestChanges).toBe(true)
    expect(codes(assessed.diagnostics)).toContain('unknown')
  })
})
