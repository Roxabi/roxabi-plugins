import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type {
  BoundCorrectionAction,
  CorrectionActionBinding,
  CorrectionEffectResult,
} from './correction-execution-contract.ts'
import type { FixIdentity, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { publishNativeContributions, taskSlot } from './fix-contributions-native.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { publish, record } from './fix-records.ts'

export async function bindCorrectionAction(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  runtime: FixWorkflowRuntime,
  binding: CorrectionActionBinding,
): Promise<CorrectionEffectResult<BoundCorrectionAction>> {
  if (runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
  const inventoryId = identity.nextRecordId('review-attempt')
  const actionInputs = [...new Set([prepared.requestId, decisionId, ...binding.contextRefs])]
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: prepared.target.candidateGitSHA,
      input: null,
      stage: 'initial',
      purpose: 'correction',
      requestId: prepared.requestId,
      policy: prepared.policy,
      slots: [
        taskSlot(
          binding.task,
          binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix',
          'action-result',
        ),
      ],
    },
    actionInputs,
    inventoryId,
  )
  const saved = await publish(publisher, inventory)
  if (!saved.ok) return { ok: false, kind: 'terminal', diagnostics: saved.diagnostics }
  const batch: NativeBatch = {
    operationId: identity.operationId,
    tasks: {
      context: `Correction ${binding.phase} for decision ${decisionId}, cause ${binding.causeId}; immutable context ${binding.contextRefs.join(',')}`,
      tasks: [binding.task],
    },
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
            ? { ok: true, value: { contributionIds: preserved.value.map((contribution) => contribution.recordId) } }
            : { ok: false, kind: 'terminal', diagnostics: preserved.diagnostics }
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
