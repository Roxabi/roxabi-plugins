import { isDeepStrictEqual } from 'node:util'
import { validateActionInputs } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type {
  BoundCorrectionAction,
  CorrectionActionBinding,
  CorrectionEffectResult,
} from './correction-execution-contract.ts'
import { reconstructFixCheckpoint } from './fix-checkpoint-state.ts'
import type { FixIdentity, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { publishNativeContributions, taskSlot } from './fix-contributions-native.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { publish, record } from './fix-records.ts'
import { type NegativeContributionOrigin, resolveNegativeContribution } from './uw-context-negative-contribution.ts'

function matchesExpandedCorrection(
  binding: CorrectionActionBinding,
  decisionId: string,
  history: DecodedHistory,
  origin: NegativeContributionOrigin,
): boolean {
  const task = binding.task
  const inputs = task.action.inputs
  const previous = origin.previous
  const { expandedContext: _old, ...oldAuthority } = previous.manifest
  const { expandedContext: _new, ...newAuthority } = inputs.manifest
  const slot = origin.slot
  const inventory = recordsOf(history).find(
    (record) => record.kind === 'review-attempt' && record.recordId === origin.inventoryId,
  )
  const stageIds = inputs.stageSources.map((ref) => ref.record.recordId)
  return (
    previous.fingerprint !== inputs.fingerprint &&
    isDeepStrictEqual(oldAuthority, newAuthority) &&
    isDeepStrictEqual(previous.stageSources, inputs.stageSources) &&
    isDeepStrictEqual(stageIds, binding.contextRefs) &&
    stageIds.includes(decisionId) &&
    inventory?.inputs.includes(decisionId) === true &&
    isDeepStrictEqual(slot.correction, { phase: binding.phase, causeId: binding.causeId, context: binding.context }) &&
    slot.role === task.agent &&
    slot.phase === (binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix') &&
    slot.output === 'action-result'
  )
}

async function authorizeExpandedCorrection(
  binding: CorrectionActionBinding,
  decisionId: string,
  readHistory: () => Promise<DecodedHistory>,
): Promise<CorrectionEffectResult<void>> {
  const task = binding.task
  const inputs = task.action.inputs
  if (inputs.manifest.expandedContext.length === 0) return { ok: true, value: undefined }
  const refuse = (reason: string): CorrectionEffectResult<void> => ({
    ok: false,
    kind: 'terminal',
    diagnostics: [reason],
    preEffectRefusal: [reason],
  })
  if (!validateActionInputs(inputs).ok || inputs.manifest.purpose !== 'correction')
    return refuse('correction-successor-task-mismatch')
  let history: DecodedHistory
  try {
    history = await readHistory()
  } catch {
    return refuse('correction-successor-history-unreadable')
  }
  const origin = resolveNegativeContribution(
    {
      actionId: task.action.snapshot.actionId,
      purpose: inputs.manifest.purpose,
      subject: inputs.manifest.subject,
      code: inputs.manifest.code,
      stageSources: inputs.stageSources,
      expandedContext: inputs.manifest.expandedContext,
    },
    [history],
  )
  if (!origin.ok) return refuse(origin.diagnostics[0]?.code ?? 'correction-successor-origin-invalid')
  if (origin.value === null) return { ok: true, value: undefined }
  if (!matchesExpandedCorrection(binding, decisionId, history, origin.value))
    return refuse('correction-successor-binding-mismatch')
  const checkpoint = reconstructFixCheckpoint(history)
  if (checkpoint.status === 'blocked')
    return refuse(checkpoint.diagnostics[0] ?? `correction-successor-checkpoint-${checkpoint.reason}`)
  if (checkpoint.status === 'complete')
    return refuse(`correction-successor-request-already-completed:${checkpoint.requestId}`)
  if (checkpoint.status === 'not-started') return refuse('correction-successor-original-request-not-observed')
  return refuse('correction-successor-live-ownership-not-bound')
}

export async function bindCorrectionAction(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  runtime: FixWorkflowRuntime,
  binding: CorrectionActionBinding,
  readHistory: () => Promise<DecodedHistory>,
): Promise<CorrectionEffectResult<BoundCorrectionAction>> {
  if (runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
  const task = binding.task
  const authorization = await authorizeExpandedCorrection(binding, decisionId, readHistory)
  if (!authorization.ok) return authorization
  const inventoryId = identity.nextRecordId('review-attempt')
  const actionInputs = [...new Set([prepared.requestId, decisionId, ...binding.contextRefs])]
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: task.action.inputs.manifest.code.head,
      inputFormat: 'omp-build:review-input/4',
      input: null,
      actionInputDigest: task.action.inputs.fingerprint,
      stage: 'initial',
      purpose: 'correction',
      requestId: prepared.requestId,
      policy: prepared.policy,
      slots: [
        {
          ...taskSlot(
            task,
            binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix',
            'action-result',
          ),
          correction: { phase: binding.phase, causeId: binding.causeId, context: binding.context },
        },
      ],
    },
    actionInputs,
    inventoryId,
  )
  const saved = await publish(publisher, inventory)
  if (!saved.ok) return { ok: false, kind: 'terminal', diagnostics: saved.diagnostics }
  const batch: NativeBatch = {
    operationId: identity.operationId,
    tasks: { context: 'omp-build correction action', tasks: [task] },
  }
  runtime.onBatch(batch)
  return {
    ok: true,
    value: {
      batch,
      async conserve(result) {
        try {
          const preserved = await publishNativeContributions(
            prepared,
            identity,
            publisher,
            inventoryId,
            [binding.task],
            binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix',
            'action-result',
            [inventoryId, ...actionInputs],
            result,
          )
          return preserved.ok
            ? {
                ok: true,
                value: {
                  contributionIds: preserved.value.map((contribution) => contribution.recordId),
                  records: preserved.value.flatMap((contribution) =>
                    contribution.kind === 'contribution'
                      ? [
                          {
                            repository: contribution.repository,
                            target: contribution.target,
                            kind: 'contribution' as const,
                            recordId: contribution.recordId,
                            payload: contribution.payload,
                          },
                        ]
                      : [],
                  ),
                },
              }
            : { ok: false, kind: 'terminal' as const, diagnostics: preserved.diagnostics }
        } catch (error) {
          return {
            ok: false,
            kind: 'terminal',
            diagnostics: [
              `native-action-conservation-failed:${error instanceof Error ? error.message : String(error)}`,
            ],
          }
        }
      },
    },
  }
}
