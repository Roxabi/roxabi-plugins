import type { DecodedHistory } from '../dist/contracts.js'
import { validateDecisionBindings, validateRecordGraph } from '../dist/contracts.js'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type {
  FixActionResult,
  FixRecord,
  FixRequestInput,
  NativePort,
  RecordPublisher,
  ReviewAuthority,
  TargetResolver,
} from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { CauseAdmission, CorrectionCause, DebtEvidence, FixFinding, FixPolicy } from './fix-domain'
import { admitCorrectionCauses, orderSelectedCauses } from './fix-domain'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { actionTask } from './fix-native-dispatch.ts'
import { nativeFixProfileByAction } from './native-review-profiles'

export function selectedCorrectionOrder(
  policy: FixPolicy,
  causes: readonly CorrectionCause[],
  findings: readonly FixFinding[],
): CauseAdmission[] {
  return orderSelectedCauses(admitCorrectionCauses(policy, causes, findings))
}

export type DefaultFixRequest = Omit<FixRequestInput, 'nativeTasks'> & {
  debtEvidence?: DebtEvidence
}

export type DefaultFixWorkflow = {
  resolver: TargetResolver
  publisher: RecordPublisher
  readHistory(): Promise<DecodedHistory>
  workflow?: ReviewAuthority
  native: NativePort
  runtime: FixWorkflowRuntime
}

export const defaultDebtEvidence: DebtEvidence = {
  important: 'unknown',
  urgent: 'unknown',
  tooLarge: 'unknown',
  evidence: { source: 'fix-workflow', status: 'unqualified' },
}
export function admitDecisionExecution(
  decision: Extract<FixRecord, { kind: 'decision' }>,
  history: DecodedHistory,
): FixActionResult<void> {
  const graph = validateRecordGraph(history)
  if (!graph.ok)
    return failure(
      `correction-execution-admission-invalid:${graph.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  const bindings = validateDecisionBindings(decision, history)
  if (!bindings.admissible)
    return failure(
      `correction-synthesis-bindings-invalid:${bindings.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  return { ok: true, value: undefined }
}

export function defaultIntakeTask(input: DefaultFixRequest): NativeTask {
  return actionTask(
    'fix-intake',
    nativeFixProfileByAction.intake,
    `Inspect only correction scope ${input.scope} for ${input.reference ?? input.contextTarget?.target ?? 'bound target'}. Preserve each original finding unchanged and return structured findings; do not classify final labels, merge causes, edit, commit, push, arm, or land.`,
    'bounded correction evidence intake',
  )
}

export function defaultSynthesisTask(): NativeTask {
  return actionTask(
    'fix-synthesis',
    nativeFixProfileByAction.synthesis,
    'Synthesize one correction-purpose decision from the supplied complete contribution payloads. Preserve source IDs, original raw associations, exact policy and seven-field causes; do not edit, commit, push, arm, or land.',
    'one correction decision from admitted intake records',
  )
}
