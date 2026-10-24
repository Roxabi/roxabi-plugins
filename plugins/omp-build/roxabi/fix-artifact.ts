import type { DebtObligation } from './correction-debt.ts'
import type { CorrectionOutcome } from './correction-policy-contract.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { failure, isRecordId } from './fix-contract.ts'
import { publish, record } from './fix-records.ts'

export type PublishedFixArtifacts = {
  correctionIds: string[]
  falsificationIds: string[]
  debtIds: string[]
}

type ArtifactState = PublishedFixArtifacts & { diagnostics: string[] }

async function publishCorrectionArtifact(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  outcome: CorrectionOutcome,
  state: ArtifactState,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const receiptInputs = [...new Set([decisionId, prepared.requestId, ...outcome.sourceContributionIds])]
  const correction = record(
    identity,
    prepared.target,
    'correction-result',
    {
      decisionId,
      causeId: outcome.cause.id,
      attempt: outcome.attempt,
      outcome: outcome.outcome,
      commitSHAs: [...outcome.commitSHAs],
      raw: {
        execution: outcome.execution,
        terminalFailure: outcome.terminalFailure,
        effectsCleanup: outcome.terminalFailure ? 'unproven' : 'not-required',
        outcome: outcome.raw,
        applyAttempts: outcome.applyAttempts.map((attempt) => ({
          round: attempt.round,
          attempt: attempt.attempt,
          result: attempt.result,
          raw: attempt.raw,
          sourceContributionIds: [...attempt.sourceContributionIds],
        })),
      },
    },
    receiptInputs,
  )
  const saved = await publish(publisher, correction)
  if (!saved.ok) {
    state.diagnostics.push(...saved.diagnostics)
    return true
  }
  state.correctionIds.push(saved.value.recordId)
  if (signal?.aborted) return false
  if (outcome.falsification === null) return true
  const falsification = record(
    identity,
    prepared.target,
    'falsification-result',
    {
      correctionResultId: correction.recordId,
      result: outcome.falsification.result,
      notes: outcome.falsification.notes,
      raw: outcome.falsification.raw,
    },
    [...new Set([correction.recordId, ...outcome.sourceContributionIds])],
  )
  const savedFalsification = await publish(publisher, falsification)
  if (savedFalsification.ok) state.falsificationIds.push(savedFalsification.value.recordId)
  else state.diagnostics.push(...savedFalsification.diagnostics)
  return true
}

async function publishDebtArtifact(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  obligation: DebtObligation,
  state: ArtifactState,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const receiptId = identity.nextRecordId('debt-receipt')
  const evidence = obligation.evidence[0]
  if (evidence === undefined) {
    state.diagnostics.push(`debt-evidence-missing:${obligation.kind}`)
    return true
  }
  const filing = obligation.issueAdmitted
    ? await prepared.debtFiling.file({
        decisionId,
        receiptId,
        target: prepared.target,
        findingIds: obligation.findingIds,
        causeIds: obligation.causeIds,
        evidence,
        retentionDiagnostics: obligation.retentionDiagnostics,
        acceptedEvidencePolicyRef: prepared.policy.version === 'evidence-v1' ? prepared.policy.acceptanceRef : null,
        fixRequestId: prepared.requestId,
      })
    : null
  if (signal?.aborted) return false
  const disposition: 'filed' | 'deferred' | 'retained' = !obligation.issueAdmitted
    ? 'retained'
    : filing?.ok
      ? 'filed'
      : 'deferred'
  const debtRecord = record(
    identity,
    prepared.target,
    'debt-receipt',
    {
      decisionId,
      findingIds: [...obligation.findingIds],
      causeIds: [...obligation.causeIds],
      disposition,
      target: filing?.ok ? filing.value.target : null,
      evidence: {
        admissionEvidence: evidence.evidence,
        issueAdmitted: obligation.issueAdmitted,
        filing: filing === null ? null : filing.ok ? filing.value.raw : { diagnostics: filing.diagnostics },
      },
    },
    [decisionId, prepared.requestId],
    receiptId,
  )
  const saved = await publish(publisher, debtRecord)
  if (saved.ok) state.debtIds.push(saved.value.recordId)
  else state.diagnostics.push(...saved.diagnostics)
  return true
}

export async function publishFixArtifacts(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  outcomes: readonly CorrectionOutcome[],
  debt: readonly DebtObligation[],
  signal?: AbortSignal,
): Promise<FixActionResult<PublishedFixArtifacts>> {
  const state: ArtifactState = { correctionIds: [], falsificationIds: [], debtIds: [], diagnostics: [] }
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  for (const outcome of outcomes) {
    if (
      signal?.aborted ||
      !(await publishCorrectionArtifact(prepared, identity, publisher, decisionId, outcome, state, signal))
    )
      return failure('fix-run-interrupted-cleanup-unproven')
  }
  for (const obligation of debt) {
    if (
      signal?.aborted ||
      !(await publishDebtArtifact(prepared, identity, publisher, decisionId, obligation, state, signal))
    )
      return failure('fix-run-interrupted-cleanup-unproven')
  }
  return state.diagnostics.length === 0
    ? {
        ok: true,
        value: {
          correctionIds: state.correctionIds,
          falsificationIds: state.falsificationIds,
          debtIds: state.debtIds,
        },
      }
    : failure(...state.diagnostics)
}

export function publishFinalFixResult(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  artifacts: PublishedFixArtifacts,
  candidateGitSHA: string,
): Promise<FixActionResult<FixRecord>> {
  if (!isRecordId(decisionId) || !/^[0-9a-f]{40}$/.test(candidateGitSHA))
    return Promise.resolve(failure('fix-result-binding-invalid'))
  return publish(
    publisher,
    record(
      identity,
      prepared.target,
      'fix-result',
      {
        requestId: prepared.requestId,
        decisionId,
        candidateGitSHA,
        correctionResultIds: artifacts.correctionIds,
        falsificationResultIds: artifacts.falsificationIds,
        debtReceiptIds: artifacts.debtIds,
      },
      [prepared.requestId, decisionId, ...artifacts.correctionIds, ...artifacts.falsificationIds, ...artifacts.debtIds],
    ),
  )
}
