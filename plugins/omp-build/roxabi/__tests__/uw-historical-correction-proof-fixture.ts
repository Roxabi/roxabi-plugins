import { actionInputDigest, canonicalValueDigest } from '../../engine/action-input.ts'
import type { ActionInputs, RecordInputRef } from '../../engine/action-input-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { Result } from '../../engine/result.ts'
import { nativeCorrectionRecords } from '../../testing/native-correction-records.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { correctionProofHistory, proofData } from './uw-historical-correction-proof-fixture-data.ts'

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

function ref<K extends CanonicalRecord['kind']>(record: Scope & { kind: K; recordId: string }) {
  return {
    scope: { repository: record.repository, target: record.target },
    kind: record.kind,
    recordId: record.recordId,
  }
}

function capturedBasis() {
  const records = nativeCorrectionRecords()
  const binding = records.find((record) => record.kind === 'workflow-binding')
  const fix = records.find((record) => record.kind === 'fix-request')
  const operator = records.find(
    (record) => record.kind === 'contribution' && record.payload.content === 'operator-request',
  )
  const initial = records.find((record) => record.kind === 'review-attempt' && record.payload.stage === 'initial')
  const decision = records.find((record) => record.kind === 'decision')
  if (!binding || !fix || operator?.kind !== 'contribution' || initial?.kind !== 'review-attempt' || !decision)
    throw new Error('Expected captured correction basis')
  const originalInputs = initial.payload.slots[0]?.action?.inputs
  const spec = originalInputs?.manifest.spec
  if (!originalInputs || spec?.kind !== 'accepted') throw new Error('Expected captured Spec and action inputs')
  const cause = decision.payload.judgment.causes.find((item) => item.id === 'cause-region')
  if (!cause) throw new Error('Expected captured region cause')
  const pull = ref(binding).scope
  const { branch, base } = binding.payload
  const priorHead = initial.payload.candidateGitSHA
  const destinationRef = `refs/heads/${branch}`
  // The capture predates the retained H1 anchor. Seed it using the captured candidate and binding.
  const anchored = must(
    buildRecord({
      ...operator,
      payload: {
        ...operator.payload,
        rawAttempts: [
          {
            attemptIndex: 0,
            data: null,
            partialText: null,
            raw: {
              candidateGitSHA: priorHead,
              publishBinding: {
                localBranch: branch,
                destinationRef,
                publicationRepository: pull.repository,
                localHead: priorHead,
                expectedRemoteSHA: priorHead,
                observed: {
                  target: pull.target,
                  baseRepository: pull.repository,
                  localRef: destinationRef,
                  localHead: priorHead,
                  remoteRepository: pull.repository,
                  pr: {
                    headRefOid: priorHead,
                    headRefName: branch,
                    headRepository: pull.repository,
                    baseRefName: base,
                  },
                },
              },
            },
          },
        ],
      },
    }),
  )
  return {
    records: records.map((record) => (record === operator ? anchored : record)),
    binding,
    fix,
    initial,
    decision,
    cause,
    originalInputs,
    spec,
    pull,
    priorHead,
  }
}

/** Extend the captured pre-apply history with immutable records, not a live correction writer. */
export function historicalCorrectionProof(
  expand?: (record: RecordInputRef) => ActionInputs['manifest']['expandedContext'],
) {
  const { records, binding, fix, initial, decision, cause, originalInputs, spec, pull, priorHead } = capturedBasis()
  const workflow = roxabiWorkflowFixtures()
  const uw = binding.payload.mandate.scope
  const mandate = workflow.fixOnlyMandate(uw)
  const contextScope = { repository: uw.repository, target: `${uw.repository}#98` }
  const contextRecord = workflow.fixOnlyMandate(contextScope)
  const planRecords = workflow.planDraftRecords(mandate)
  const plan = planRecords.find((record) => record.payload.phase === 'result' && record.payload.action === 'plan')
  if (plan?.payload.phase !== 'result' || plan.payload.action !== 'plan') throw new Error('Expected plan result')
  const head = 'c'.repeat(40)
  const proof = proofData(spec, { repository: pull.repository, commit: head })
  const manifest: ActionInputs['manifest'] = {
    ...originalInputs.manifest,
    expandedContext: [
      ...originalInputs.manifest.expandedContext,
      ...(expand?.({
        source: 'record',
        record: ref(contextRecord),
        selector: '/payload',
        digest: canonicalValueDigest(contextRecord.payload),
      }) ?? []),
    ],
    deliveryData: [
      {
        source: 'record',
        record: ref(plan),
        selector: '/payload/structured',
        digest: canonicalValueDigest(plan.payload.structured),
        role: 'plan',
      },
    ],
  }
  const fingerprint = actionInputDigest(manifest)
  const inputs: ActionInputs = {
    ...originalInputs,
    manifest,
    fingerprint,
    stageSources: [
      {
        source: 'record',
        record: ref(decision),
        selector: '/payload',
        digest: canonicalValueDigest(decision.payload),
      },
    ],
  }
  const action = { actionId: proof.actionId, inputs }
  const identity = (scope: Scope, recordId: string) => ({
    ...scope,
    version: 1 as const,
    recordId,
    operationId: `op-${recordId}`,
    runId: fix.runId,
  })
  const slot = {
    slotId: 'historical-apply-slot',
    phase: 'fix' as const,
    role: 'R-review-fix-apply',
    chunk: null,
    action,
  }
  const inventoryId = 'historical-apply-inventory'
  const inventory = must(
    buildRecord(
      {
        ...identity(pull, inventoryId),
        kind: 'review-attempt',
        payload: {
          stage: 'initial',
          purpose: 'correction',
          requestId: fix.recordId,
          rootAttemptId: inventoryId,
          inputFormat: initial.payload.inputFormat,
          input: fingerprint,
          actionInputDigest: fingerprint,
          candidateGitSHA: priorHead,
          policy: initial.payload.policy,
          slots: [
            {
              ...slot,
              required: true,
              output: 'action-result',
              classId: null,
              sourceFindingIds: [],
              correction: { phase: 'apply', causeId: cause.id, context: {} },
            },
          ],
        },
      },
      [decision.recordId],
    ),
  )
  const source = must(
    buildRecord(
      {
        ...identity(pull, 'historical-apply-source'),
        kind: 'contribution',
        payload: {
          content: 'action-result',
          inventoryId: inventory.recordId,
          host: { ...slot, origin: 'native', childId: proof.childId },
          rawAttempts: [proof.submission],
          native: proof.native,
          structured: proof.data,
          findings: null,
        },
      },
      [fix.recordId, decision.recordId],
    ),
  )
  const disposition = must(
    buildRecord({
      ...identity(uw, 'historical-region-disposition'),
      kind: 'cause-disposition',
      payload: {
        format: 'omp-build-cause-disposition/2',
        origin: spec.effective.own,
        basis: { versionVector: [spec.effective.own], capture: null },
        subject: {
          kind: 'cause',
          decision: ref(decision),
          cause,
          findings: decision.payload.judgment.findings.filter((finding) => cause.findingIds.includes(finding.id)),
        },
        previous: null,
        adjudication: null,
        outcome: { state: 'final', disposition: 'fix-original', blocking: true, reason: 'Restore region persistence' },
        diagnostics: [],
      },
    }),
  )
  const correction = must(
    buildRecord({
      ...identity(pull, 'historical-region-correction'),
      kind: 'correction-result',
      payload: {
        decisionId: decision.recordId,
        causeDisposition: ref(disposition),
        causeId: cause.id,
        attempt: 1,
        outcome: 'applied',
        commitSHAs: [head],
        appliedContributionId: source.recordId,
        raw: {
          terminalFailure: false,
          effectsCleanup: 'not-required',
          execution: { causeId: cause.id, falsificationRound: 1, attempted: true },
          applyAttempts: [{ round: 1, result: 'applied', sourceContributionIds: [source.recordId] }],
        },
      },
    }),
  )
  const result = must(
    buildRecord({
      ...identity(pull, 'historical-fix-result'),
      kind: 'fix-result',
      payload: {
        requestId: fix.recordId,
        decisionId: decision.recordId,
        candidateGitSHA: head,
        correctionResultIds: [correction.recordId],
        falsificationResultIds: [],
        causeDispositionRefs: [ref(disposition)],
        criterionReceipt: { sourceContributionId: source.recordId, criteria: [proof.receipt] },
      },
    }),
  )
  const review = correctionProofHistory(pull, [...records, inventory, source, correction, result])
  const reviewWithoutSource = correctionProofHistory(pull, [...records, inventory, correction, result])
  const issue = correctionProofHistory(uw, [mandate, ...planRecords, disposition])
  return {
    mandate,
    spec,
    head,
    priorHead,
    evidence: proof.receipt.evidence,
    result,
    source,
    correction,
    review,
    reviewWithoutSource,
    issue,
    contextHistory: correctionProofHistory(contextScope, [contextRecord]),
    planActionId: plan.payload.actionId,
    request: {
      actionId: 'historical-proof-reader',
      purpose: 'review' as const,
      subject: manifest.subject,
      code: { ...manifest.code, head, referenceCommit: head },
      stageSources: [],
      expandedContext: [],
    },
  }
}
