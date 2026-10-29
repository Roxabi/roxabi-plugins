import { decisionSchema } from '../dist/contracts.js'
import type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import { actionRequest, codePin, confirmPreparedAction, deliveryTask, recordStageRef } from './delivery-action.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { failure, isRecordId } from './fix-contract.ts'
import { publishNativeContributions, taskSlot } from './fix-contributions-native.ts'
import { publish, record } from './fix-records.ts'
import type { UwOperations } from './uw-contract.ts'

export type PreparedCorrectionSynthesis = {
  inventoryId: string
  sourceContributionIds: string[]
  batch: NativeBatch
}

/** Synthesis cites confirmed contribution payloads as stage records, not opaque IDs or embedded JSON. */
export async function prepareCorrectionSynthesis(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  sourceContributions: readonly FixRecord[],
  task: Omit<NativeTask, 'action'>,
  operations: UwOperations,
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
  const head = prepared.target.candidateGitSHA
  if (head === null || prepared.target.baseGitSHA === null) return failure('prepare-action-unavailable')
  const pinned = codePin(prepared.target.repository, prepared.target.baseGitSHA, head, head)
  if (!pinned.ok) return failure('code-unobserved')
  const stageRecords = sourceContributions.flatMap((record) =>
    record.kind === 'contribution' || record.kind === 'decision' ? [record] : [],
  )
  if (stageRecords.length !== sourceContributions.length) return failure('correction-synthesis-sources-invalid')
  const preparedAction = await confirmPreparedAction(
    operations,
    actionRequest({
      actionId: inventoryId,
      purpose: 'correction',
      subject: prepared.subject,
      code: pinned.code,
      stageSources: stageRecords.map(recordStageRef),
    }),
  )
  if (!preparedAction.ok) return failure('prepare-action-unavailable')
  const attached = deliveryTask({
    name: task.name,
    agent: task.agent,
    procedure: task.task,
    solutionSpace: task.solutionSpace,
    prepared: preparedAction.value,
    tools: task.tools,
    proofEvidence: task.proofEvidence,
  })
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: prepared.inventoryId,
      candidateGitSHA: prepared.target.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4',
      input: preparedAction.value.inputs.fingerprint,
      actionInputDigest: preparedAction.value.inputs.fingerprint,
      stage: 'synthesis',
      purpose: 'correction',
      policy: prepared.policy,
      slots: [taskSlot(attached, 'synthesis', 'decision')],
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
          context: 'omp-build correction action. Read only the procedure and the index named on the task.',
          tasks: [attached],
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
