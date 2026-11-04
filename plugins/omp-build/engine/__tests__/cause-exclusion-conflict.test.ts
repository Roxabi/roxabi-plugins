import { describe, expect, it } from 'vitest'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { assessCauseDispositions } from '../cause-disposition.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { must } from './workflow-test-support.ts'

const uw = { repository: 'acme/app', target: 'acme/app#42' }
const pr = { repository: 'acme/app', target: 'acme/app#44' }
const fixtures = roxabiWorkflowFixtures()
const body = 'Save region; bulk export is excluded'
const spec = must(
  canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Save the selected region' }],
    invariants: [],
    exclusions: ['bulk export'],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  }),
)
const ownSpec = fixtures.ownSpecFromSnapshot(uw, {
  spec,
  raw: { reference: uw.target, body, bodySha256: specDigest(body), lastEditedAt: '2026-10-27T12:00:00.000Z' },
})
const mandate = fixtures.featureMandate(uw, { recordId: 'mandate-42', body, ownSpec })
const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'exclusion-conflict', label: 'issue' })
if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted Spec')
const context = { original: uw, effective: graph.inputs.manifest.spec.effective }
const finding = graph.decision.payload.judgment.findings[0]
const cause = graph.decision.payload.judgment.causes[0]
if (!finding || !cause || !finding.target) throw new Error('expected finding and cause')
const claim = {
  sourceFindingId: finding.sourceFindingIds[0],
  target: finding.target,
  exclusion: { spec: context.effective.own, index: 0 },
  concern: 'additional-work' as const,
  reason: 'The bulk export is excluded',
}

function assess(
  concerns: readonly ('security' | 'introduced-regression')[],
  purpose: 'review' | 'correction' = 'review',
) {
  const original = graph.decision.payload.judgment
  const common = {
    format: original.format,
    policy: original.policy,
    sourceContributionIds: original.sourceContributionIds,
    findings: original.findings,
    causes: [{ ...cause, proposedDisposition: 'report' as const }],
    exclusionClaims: [claim, ...concerns.map((concern) => ({ ...claim, concern }))],
    unassignedFindings: original.unassignedFindings,
  }
  const judgment = purpose === 'review' ? { ...original, ...common } : { ...common, purpose: 'correction' as const }
  const decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision' || synthesis.kind !== 'contribution') throw new Error('expected decision records')
  const requestContribution = must(
    parseRecord({
      version: 1,
      ...pr,
      recordId: 'correction-request-source',
      runId: 'run',
      operationId: 'correction-request-source-op',
      inputs: [],
      kind: 'contribution',
      payload: {
        content: 'operator-request',
        inventoryId: null,
        host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
        rawAttempts: [
          {
            attemptIndex: 0,
            data: null,
            raw: { operatorRequest: { request: 'Repair the finding' } },
            partialText: null,
          },
        ],
        native: null,
        structured: null,
        findings: null,
      },
    }),
  )
  const request = must(
    buildRecord({
      version: 1,
      ...pr,
      recordId: 'correction-request',
      runId: 'run',
      operationId: 'correction-request-op',
      kind: 'fix-request',
      payload: {
        requestContributionId: requestContribution.recordId,
        originalSpec: context.effective.own,
        existingReviewId: null,
        scope: 'all findings',
        landing: false,
      },
    }),
  )
  const rootPayload = graph.root.payload
  if (rootPayload.stage !== 'initial') throw new Error('expected initial inventory')
  const correctionRoot = must(
    buildRecord({
      ...graph.root,
      payload: {
        rootAttemptId: rootPayload.rootAttemptId,
        candidateGitSHA: rootPayload.candidateGitSHA,
        inputFormat: rootPayload.inputFormat,
        input: rootPayload.input,
        actionInputDigest: rootPayload.actionInputDigest,
        slots: rootPayload.slots,
        stage: 'initial',
        purpose: 'correction',
        requestId: request.recordId,
        policy: rootPayload.policy,
      },
    }),
  )
  const correctionSynthesis = must(
    parseRecord({
      ...graph.synthesis,
      payload: { ...graph.synthesis.payload, purpose: 'correction' },
    }),
  )
  const source = {
    ...graph.history,
    operations: [
      ...(purpose === 'correction' ? [operation(requestContribution), operation(request)] : []),
      ...graph.history.operations.flatMap((entry) => {
        if (purpose === 'correction' && entry.recordId === graph.review.recordId) return []
        if (purpose === 'correction' && entry.recordId === correctionRoot.recordId) return [operation(correctionRoot)]
        if (purpose === 'correction' && entry.recordId === correctionSynthesis.recordId)
          return [operation(correctionSynthesis)]
        if (entry.recordId === decision.recordId) return [operation(decision)]
        if (entry.recordId === synthesis.recordId) return [operation(synthesis)]
        return [entry]
      }),
    ],
  }
  return must(
    assessCauseDispositions({
      context,
      source: { kind: 'decision', decision },
      histories: [fixtures.historyFrom([mandate]), source],
      adjudications: [],
    }),
  )
}

describe('exclusion classification', () => {
  it('reports unambiguous excluded additional work', () => {
    expect(assess([]).outcomes[0]?.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  })
  it.each(['security', 'introduced-regression'] as const)('keeps conflicting %s work pending', (concern) => {
    const result = assess([concern])
    expect(result.outcomes[0]?.outcome.state).toBe('pending-blocking')
    expect(result.diagnostics.map((item) => item.code)).toContain('exclusion-claim-conflict')
  })
  it('authenticates correction-purpose excluded additional work before testing contradictions', () => {
    const result = assess([], 'correction')
    expect(result.outcomes[0]?.subject.kind).toBe('cause')
    expect(result.outcomes[0]?.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  })
  it.each(['security', 'introduced-regression'] as const)(
    'keeps correction-purpose %s contradictions pending',
    (concern) => {
      const result = assess([concern], 'correction')
      expect(result.outcomes[0]?.outcome.state).toBe('pending-blocking')
      expect(result.diagnostics.map((item) => item.code)).toContain('exclusion-claim-conflict')
    },
  )
})
