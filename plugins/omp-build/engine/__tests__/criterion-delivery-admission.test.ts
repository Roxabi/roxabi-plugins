import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import {
  acceptedActionInputs,
  fixtureReviewClassCatalogues,
  observeFixtureCatalogue,
  standaloneReviewInputs,
} from '../../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, reviewRoot, TEST_HEAD } from '../../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../../testing/record-decisions.ts'
import { historicalRecordFrames, history, observedComment, operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  eligiblePlan,
  shippedMandate,
} from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs, DeliveryDataRef } from '../action-input-schema.ts'
import { recordInputRefSchema } from '../action-input-schema.ts'
import { criterionAssessmentForDecision } from '../criterion-decision.ts'
import { selectedDeclarations } from '../criterion-decision-selection.ts'
import { criterionEvidenceSchema } from '../criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../criterion-verdict-schema.ts'
import { validateProspectiveRecord, validateRecordGraph } from '../history-graph.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Diagnostic } from '../record-values.ts'
import { validateDecision } from '../review-decision.ts'
import { reviewCandidateCode } from '../review-inventory-input.ts'
import {
  bindExternalRef,
  type MandateRecord,
  mandateScope,
  type ReceiptRecord,
  recordsOf,
} from '../workflow-control.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { evidenceDeclaration } from './criterion-admission-fixture.ts'
import { deliveredLeaf } from './uw-delivery-proof-fixture.ts'
import { binding, history as nativeHistory } from './workflow-test-support.ts'

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
  const found = eligiblePlan(mandate, [roxabiWorkflowFixtures().historyFrom([mandate])]).find(isPlanResult)
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

function withDeliveryData(inputs: ActionInputs, deliveryData: DeliveryDataRef[]): ActionInputs {
  const manifest = { ...inputs.manifest, deliveryData }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

describe('authorized criterion delivery admission', () => {
  test('historical criterion approval requires the empty-findings producer to bind its slot and full action', async () => {
    const fixture = await deliveredLeaf()
    const { review } = fixture
    const source = review.history.source
    const records = recordsOf(review.history)
    const slotAction = review.root.payload.slots.find((slot) => slot.slotId === 'spec-0')?.action
    if (slotAction === undefined) throw new Error('Expected captured criterion producer action')
    expect(review.spec.payload.findings).toEqual([])

    const wrongAction = {
      ...review.spec,
      payload: {
        ...review.spec.payload,
        host: { ...review.spec.payload.host, action: { ...slotAction, actionId: 'other-producer' } },
      },
    }
    const otherStageSource = recordInputRefSchema.parse({
      source: 'record',
      record: { scope: source.scope, kind: 'contribution', recordId: review.panel.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(review.panel.payload),
    })
    const changedSlotCapture = {
      ...slotAction,
      inputs: { ...slotAction.inputs, stageSources: [otherStageSource] },
    }
    const wrongSnapshot = {
      ...review.root,
      payload: {
        ...review.root.payload,
        slots: review.root.payload.slots.map((slot) =>
          slot.slotId === 'spec-0' ? { ...slot, action: changedSlotCapture } : slot,
        ),
      },
    }
    const matchingWrongAction = {
      ...review.spec,
      payload: { ...review.spec.payload, host: { ...review.spec.payload.host, action: changedSlotCapture } },
    }
    for (const replacements of [[], [wrongAction], [wrongSnapshot, matchingWrongAction]]) {
      const frames = records.flatMap((record) =>
        historicalRecordFrames(replacements.find((changed) => changed.recordId === record.recordId) ?? record),
      )
      const historical = decodeHistory({
        ...source,
        comments: frames.map((body, index) => {
          const id = String(index + 1)
          return observedComment({ locator: `comment-${id}`, nativeId: id, author: source.expectedAuthor, body })
        }),
      })
      expect(validateRecordGraph(historical).ok).toBe(true)
      const observed = recordsOf(historical).find((record) => record.recordId === review.decision.recordId)
      if (observed?.kind !== 'decision') throw new Error('Expected native historical decision')
      const assessed = validateDecision(observed, historical, fixtureReviewClassCatalogues(), null, [
        review.issueHistory,
      ])
      if (replacements.length === 0) expect(assessed).toMatchObject({ admissible: true, verdict: 'Approve (clean)' })
      else {
        expect(assessed).toMatchObject({ admissible: false, verdict: null })
        expect(assessed.diagnostics).toContainEqual(
          expect.objectContaining({ code: 'malformed', message: expect.stringContaining(review.spec.recordId) }),
        )
      }
    }
  })

  test('keeps a produced plan with a null admission eligible', () => {
    const mandate = shippedMandate()
    const plan = planResult(mandate)
    const bound = boundReview(mandate)
    expect(plan.payload.admission).toBeNull()
    const diagnostics: Diagnostic[] = []
    selectedDeclarations(
      [
        scoped(
          [
            ...recordsOf(roxabiWorkflowFixtures().historyFrom([mandate])).filter(
              (record) => record.kind === 'spec-identity',
            ),
            ...eligiblePlan(mandate, [roxabiWorkflowFixtures().historyFrom([mandate])]),
          ],
          mandate,
        ),
        bound.bindingHistory,
      ],
      withDeliveryData(bound.inputs, [refFor(plan, 'plan', '/payload/structured', plan.payload.structured)]),
      diagnostics,
      fixtureReviewClassCatalogues(),
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

  test('refuses an implementation start from another mandate', async () => {
    const fixture = await deliveredLeaf()
    const positive: Diagnostic[] = []
    selectedDeclarations(fixture.observation.histories, fixture.inputs, positive, fixtureReviewClassCatalogues())
    expect(positive).toEqual([])
    const current = { ...fixture.mandate, recordId: 'mandate-current', operationId: 'mandate-current-op' }
    const plan = planResult(current)
    const bound = boundReview(current)
    const inputs = bound.inputs
    const headed = fixture.implementation
    if (!isImplementResult(headed) || headed.payload.structured?.outcome !== 'implemented')
      throw new Error('expected produced implementation')
    const issue = fixture.observation.histories.find((item) => item.source.scope.target === fixture.uw.target)
    const start =
      issue &&
      recordsOf(issue).find(
        (record) =>
          record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'start',
      )
    if (!start) throw new Error('authenticated implementation start missing')
    const diagnostics: Diagnostic[] = []
    selectedDeclarations(
      [scoped([current, plan, start, headed], current), bound.bindingHistory],
      withDeliveryData(inputs, [
        refFor(headed, 'implementation', '/payload/structured/criteria/0', headed.payload.structured.criteria[0]),
      ]),
      diagnostics,
      fixtureReviewClassCatalogues(),
    )
    expect(codes(diagnostics)).toContain('unconfirmed')
  })

  test('requires complete historical inputs even for an implementation claim without cited evidence', async () => {
    const fixture = await deliveredLeaf()
    const receipt = fixture.implementation
    if (!isImplementResult(receipt) || receipt.payload.structured?.outcome !== 'implemented')
      throw new Error('expected produced implementation')
    const declaration = { target: fixture.declaration.target, verification: 'unverified' as const, reason: 'not run' }
    const payload = receipt.payload
    const structured = { ...receipt.payload.structured, criteria: [declaration] }
    const ref = recordInputRefSchema.parse({
      source: 'record',
      record: { scope: fixture.pullRequest, kind: 'workflow-binding', recordId: fixture.binding.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(fixture.binding.payload),
    })
    const cases = {
      valid: ref,
      absentRecord: { ...ref, record: { ...ref.record, recordId: 'missing-context-record' } },
      wrongScope: { ...ref, record: { ...ref.record, scope: fixture.uw } },
      wrongSelector: { ...ref, selector: '/not-a-field' },
      wrongDigest: { ...ref, digest: canonicalValueDigest('different value') },
    }
    const issue = fixture.review.issueHistory
    const otherHistories = fixture.observation.histories.filter((item) => item !== issue)
    const inputs = withDeliveryData(fixture.inputs, [
      refFor(receipt, 'implementation', '/payload/structured/criteria/0', declaration),
    ])
    for (const [label, expansion] of Object.entries(cases)) {
      const manifest = { ...payload.inputs.manifest, expandedContext: [expansion] }
      const changed = { ...payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
      const records = recordsOf(issue).map((record): CanonicalRecord => {
        if (record.recordId === receipt.recordId)
          return { ...receipt, payload: { ...payload, structured, inputs: changed } }
        if (
          record.kind === 'action-receipt' &&
          record.payload.action === 'implement' &&
          record.payload.phase === 'start' &&
          record.recordId === payload.start.recordId
        )
          return { ...record, payload: { ...record.payload, inputs: changed } }
        return record
      })
      const native = nativeHistory(records, fixture.uw)
      const diagnostics: Diagnostic[] = []
      const selected = selectedDeclarations(
        [native, ...otherHistories],
        inputs,
        diagnostics,
        fixtureReviewClassCatalogues(),
      )
      expect(selected.declarations, label).toEqual(label === 'valid' ? [declaration] : [])
      expect(selected.evidence, label).toEqual([])
      expect(selected.declarationFacts, label).toHaveLength(label === 'valid' ? 1 : 0)
      expect(diagnostics.length === 0, label).toBe(label === 'valid')
    }
  })

  test('refuses a forged external author and a mismatched operation id', async () => {
    const { mandate, implementation: receipt } = await deliveredLeaf()
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
    const observed = observeFixtureCatalogue(history([root, source, verdict]))
    const code = reviewCandidateCode(verdict.payload.judgment, observed)
    const assessment = criterionAssessmentForDecision(
      verdict.payload.judgment,
      stored,
      { declarations: [], evidence: [], verdicts: [], diagnostics: [] },
      code,
      [observed],
    )
    const admitted = validateDecision(verdict, observed, fixtureReviewClassCatalogues(), null)
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

  test('refuses unresolved version-claim and code-link references before admission', async () => {
    const fixture = await deliveredLeaf()
    const { mandate, inputs, implementation: receipt, head } = fixture
    if (
      !isImplementResult(receipt) ||
      receipt.payload.structured === null ||
      receipt.payload.structured.outcome === 'missing-context'
    )
      throw new Error('expected a genuinely published implementation result')
    const declaration = receipt.payload.structured.criteria[0]
    if (declaration?.verification !== 'evidence' || !declaration.evidence[0])
      throw new Error('expected captured implementation evidence')
    const aligned = criterionEvidenceSchema.parse(declaration.evidence[0])
    if (aligned.method !== 'test') throw new Error('expected captured test evidence')
    const structured = receipt.payload.structured
    // Deliberately corrupt only the negative receipt; the control below remains the real published record.
    const withCriteria = (evidence: typeof aligned): ImplementResult => ({
      ...receipt,
      payload: { ...receipt.payload, structured: { ...structured, criteria: [evidenceDeclaration(evidence)] } },
    })
    const missing = recordInputRefSchema.parse({
      source: 'record',
      record: { scope: mandateScope(mandate), kind: 'contribution', recordId: 'missing-link' },
      selector: '/recordId',
      digest: canonicalValueDigest('missing-link'),
    })
    const clearDiagnostics: Diagnostic[] = []
    selectedDeclarations(fixture.observation.histories, inputs, clearDiagnostics, fixtureReviewClassCatalogues())
    const unresolved = criterionEvidenceSchema.parse({
      ...aligned,
      after: { ...aligned.after, versionClaim: { ...aligned.after.versionClaim, references: [missing] } },
    })
    if (unresolved.method !== 'test') throw new Error('expected test evidence')
    const refusedReceipt = withCriteria(unresolved)
    const refusedDiagnostics: Diagnostic[] = []
    const original = fixture.review.issueHistory
    const rewritten = roxabiWorkflowFixtures().historyFrom(
      recordsOf(original).map((record) => (record.recordId === receipt.recordId ? refusedReceipt : record)),
      'operator',
      'operator',
    )
    // The version-claim mutation does not change the Git bytes independently observed for the real action.
    const forgedHistory = decodeHistory({ ...original.source, comments: rewritten.source.comments })
    selectedDeclarations(
      [
        forgedHistory,
        ...fixture.observation.histories.filter((item) => item.source.scope.target !== fixture.uw.target),
      ],
      withDeliveryData(inputs, [
        refFor(refusedReceipt, 'implementation', '/payload/structured/criteria/0', evidenceDeclaration(unresolved)),
      ]),
      refusedDiagnostics,
      fixtureReviewClassCatalogues(),
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
      fixture.observation.histories,
    )
    expect(clearDiagnostics).toEqual([])
    expect(codes(refusedDiagnostics)).toContain('unknown')
    expect(refusedDiagnostics.map((item) => item.message).join('\n')).toContain('missing-link')
    expect(assessed.forceRequestChanges).toBe(true)
    expect(codes(assessed.diagnostics)).toContain('unknown')
  })
})
