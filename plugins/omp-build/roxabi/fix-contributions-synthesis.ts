import { decisionSchema } from '../dist/contracts.js'
import type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { failure, isRecordId } from './fix-contract.ts'
import { publishNativeContributions, taskSlot } from './fix-contributions-native.ts'
import { publish, record } from './fix-records.ts'
import { modelContributionPayload } from './native-contribution'

export type PreparedCorrectionSynthesis = {
  inventoryId: string
  sourceContributionIds: string[]
  batch: NativeBatch
}

/** Synthesis receives full confirmed findings and their immutable raw provenance, not opaque IDs. */
export async function prepareCorrectionSynthesis(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  sourceContributions: readonly FixRecord[],
  task: NativeTask,
): Promise<FixActionResult<PreparedCorrectionSynthesis>> {
  const sourceContributionIds = sourceContributions.map((record) => record.recordId)
  if (
    sourceContributionIds.length === 0 ||
    sourceContributionIds.some((id) => !isRecordId(id)) ||
    new Set(sourceContributionIds).size !== sourceContributionIds.length
  ) {
    return failure('correction-synthesis-sources-invalid')
  }
  if (
    !isRecordId(task.name) ||
    task.agent.trim().length === 0 ||
    task.task.trim().length === 0 ||
    task.solutionSpace.trim().length === 0
  ) {
    return failure('correction-synthesis-task-invalid')
  }
  const inventoryId = identity.nextRecordId('review-attempt')
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: prepared.inventoryId,
      candidateGitSHA: prepared.target.candidateGitSHA,
      input: null,
      stage: 'synthesis',
      purpose: 'correction',
      policy: prepared.policy,
      slots: [taskSlot(task, 'synthesis', 'decision')],
    },
    [prepared.inventoryId, ...sourceContributionIds],
    inventoryId,
  )
  const saved = await publish(publisher, inventory)
  if (!saved.ok) return saved
  return {
    ok: true,
    value: {
      inventoryId,
      sourceContributionIds,
      batch: {
        operationId: identity.operationId,
        tasks: {
          context: `Correction synthesis for ${prepared.target.target}; policy ${JSON.stringify(prepared.policy)}; confirmed contributions ${JSON.stringify(sourceContributions.map((record) => ({ recordId: record.recordId, payload: record.kind === 'contribution' ? modelContributionPayload(record.payload) : record.payload })))}`,
          tasks: [task],
        },
      },
    },
  }
}
export type PreservedSynthesis = { result: NativeBatchResult; contributions: FixRecord[] }

export function finalizeCorrectionSynthesis(
  prepared: PreparedFix,
  synthesis: PreparedCorrectionSynthesis,
  identity: FixIdentity,
  publisher: RecordPublisher,
  preserved: PreservedSynthesis,
  signal?: AbortSignal,
): Promise<FixActionResult<FixRecord>> {
  if (signal?.aborted) return Promise.resolve(failure('fix-run-interrupted-cleanup-unproven'))
  const expected = synthesis.batch.tasks.tasks[0]
  const child = preserved.result.children[0]
  const contribution = preserved.contributions[0]
  if (
    !expected ||
    preserved.result.children.length !== 1 ||
    !child ||
    !contribution ||
    child.id === null ||
    child.expectedId !== expected.name
  )
    return Promise.resolve(failure('correction-synthesis-identity-mismatch'))
  if (!preserved.result.complete || !child.usable || child.structured === null)
    return Promise.resolve(failure('correction-synthesis-incomplete'))
  const judgment = decisionSchema.safeParse(child.structured)
  if (!judgment.success || judgment.data.purpose !== 'correction')
    return Promise.resolve(failure('correction-synthesis-decision-invalid'))
  const sources = judgment.data.sourceContributionIds
  if (
    sources.length !== synthesis.sourceContributionIds.length ||
    new Set(sources).size !== sources.length ||
    sources.some((id) => !synthesis.sourceContributionIds.includes(id))
  ) {
    return Promise.resolve(failure('correction-synthesis-sources-mismatch'))
  }
  return publish(
    publisher,
    record(
      identity,
      prepared.target,
      'decision',
      {
        originalContributionId: contribution.recordId,
        judgment: child.structured,
      },
      [synthesis.inventoryId, contribution.recordId, ...synthesis.sourceContributionIds],
    ),
  )
}

/** Retain every synthesis submission before strict decision admission. */
export async function publishCorrectionSynthesis(
  prepared: PreparedFix,
  synthesis: PreparedCorrectionSynthesis,
  identity: FixIdentity,
  publisher: RecordPublisher,
  result: NativeBatchResult,
): Promise<FixActionResult<FixRecord>> {
  const contributions = await publishNativeContributions(
    prepared,
    identity,
    publisher,
    synthesis.inventoryId,
    synthesis.batch.tasks.tasks,
    'synthesis',
    'decision',
    [synthesis.inventoryId, ...synthesis.sourceContributionIds],
    result,
  )
  return contributions.ok
    ? finalizeCorrectionSynthesis(prepared, synthesis, identity, publisher, {
        result,
        contributions: contributions.value,
      })
    : contributions
}
