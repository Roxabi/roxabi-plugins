import type { CriterionDeclaration, Ref } from '../dist/contracts.js'
import type { CorrectionOutcome } from './correction-policy-contract.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { failure, isRecordId } from './fix-contract.ts'
import type { CorrectionCriterionSource } from './fix-criterion-receipt.ts'
import { publish, record } from './fix-records.ts'

export type PublishedFixArtifacts = {
  correctionIds: string[]
  falsificationIds: string[]
  causeDispositionRefs: Ref<'cause-disposition'>[]
}

type ArtifactState = PublishedFixArtifacts & { diagnostics: string[] }

async function publishCorrectionArtifact(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  outcome: CorrectionOutcome,
  disposition: Ref<'cause-disposition'>,
  state: ArtifactState,
  signal: AbortSignal | undefined,
  criterionSources: readonly CorrectionCriterionSource[],
): Promise<boolean> {
  const attempt =
    outcome.outcome === 'applied'
      ? [...outcome.applyAttempts].reverse().find((item) => item.round === outcome.attempt && item.result === 'applied')
      : undefined
  const appliedContributionId =
    attempt?.sourceContributionIds.length === 1 ? (attempt.sourceContributionIds[0] ?? null) : null
  const criterionObservations =
    outcome.outcome === 'applied'
      ? criterionSources.flatMap((source) => {
          const sourceContributionId = source.contributionIds[0]
          return source.causeId === outcome.cause.id &&
            source.phase !== 'apply' &&
            source.contributionIds.length === 1 &&
            sourceContributionId !== undefined
            ? [{ sourceContributionId, head: source.head }]
            : []
        })
      : []
  const receiptInputs = [
    ...new Set([
      decisionId,
      prepared.requestId,
      ...outcome.sourceContributionIds,
      ...criterionObservations.map((item) => item.sourceContributionId),
    ]),
  ]
  const correction = record(
    identity,
    prepared.target,
    'correction-result',
    {
      decisionId,
      causeId: outcome.cause.id,
      causeDisposition: disposition,
      attempt: outcome.attempt,
      outcome: outcome.outcome,
      commitSHAs: [...outcome.commitSHAs],
      appliedContributionId,
      criterionObservations,
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

export async function publishFixArtifacts(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  outcomes: readonly CorrectionOutcome[],
  dispositions: { refs: Ref<'cause-disposition'>[]; executable: ReadonlyMap<string, Ref<'cause-disposition'>> },
  signal?: AbortSignal,
  criterionSources: readonly CorrectionCriterionSource[] = [],
): Promise<FixActionResult<PublishedFixArtifacts>> {
  const state: ArtifactState = {
    correctionIds: [],
    falsificationIds: [],
    causeDispositionRefs: dispositions.refs,
    diagnostics: [],
  }
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  for (const outcome of outcomes) {
    const disposition = dispositions.executable.get(outcome.cause.id)
    if (disposition === undefined) return failure(`correction-disposition-missing:${outcome.cause.id}`)
    if (
      signal?.aborted ||
      !(await publishCorrectionArtifact(
        prepared,
        identity,
        publisher,
        decisionId,
        outcome,
        disposition,
        state,
        signal,
        criterionSources,
      ))
    )
      return failure('fix-run-interrupted-cleanup-unproven')
  }
  return state.diagnostics.length === 0
    ? {
        ok: true,
        value: {
          correctionIds: state.correctionIds,
          falsificationIds: state.falsificationIds,
          causeDispositionRefs: state.causeDispositionRefs,
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
  criterionReceipt?: { sourceContributionId: string; criteria: CriterionDeclaration[] },
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
        causeDispositionRefs: artifacts.causeDispositionRefs,
        ...(criterionReceipt === undefined ? {} : { criterionReceipt }),
      },
      [
        prepared.requestId,
        decisionId,
        ...artifacts.correctionIds,
        ...artifacts.falsificationIds,
        ...(criterionReceipt === undefined ? [] : [criterionReceipt.sourceContributionId]),
      ],
    ),
  )
}
