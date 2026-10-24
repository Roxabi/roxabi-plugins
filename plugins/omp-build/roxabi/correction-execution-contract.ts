import type { Json } from '../dist/contracts.js'
import type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.js'
import type { NativeBatchController } from '../omp/review-runtime/controller.js'
import type { PreparedFix } from './fix-contract'
import type { CorrectionCause } from './fix-domain'

type EffectFailureKind = 'retryable' | 'terminal'
export type CorrectionEffectResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      kind: EffectFailureKind
      diagnostics: string[]
      /** Authority denied before inventory, native dispatch, or repository effect. */
      preEffectRefusal?: readonly string[]
    }

export type FalsificationFact = {
  guardId: string
  guard: string
  intendedScenario: string
  removedProductionGuard: boolean
  proofFailedIntendedScenario: boolean
  proofToolCallId: string | null
  proofUnavailableReason: string | null
  inconclusive?: boolean
  detail?: string
}

export type CorrectionExecution = {
  apply(cause: CorrectionCause, attempt: 1 | 2 | 3): Promise<CorrectionEffectResult<CorrectionApplyResult>>
  revert(commitSHAs: readonly string[]): Promise<CorrectionEffectResult<CorrectionRevertResult>>
  revalidateRequiredPaths(
    causes: readonly CorrectionCause[],
  ): Promise<CorrectionEffectResult<CorrectionRevalidationResult>>
  falsify(
    cause: CorrectionCause,
    commitSHAs: readonly string[],
  ): Promise<CorrectionEffectResult<CorrectionFalsificationResult>>
  head(): Promise<CorrectionEffectResult<string>>
  push(): Promise<CorrectionEffectResult<CorrectionPushResult>>
}

export type CorrectionApplyResult = { commitSHAs: string[]; raw: Json; contributionIds: string[] }
export type CorrectionRevertResult = { reverted: string[]; revertSHA: string; contributionIds: string[] }
export type CorrectionRevalidationResult = { checked: Json[]; contributionIds: string[] }
export type CorrectionFalsificationResult = {
  facts: FalsificationFact[]
  raw: Json
  contributionIds: string[]
  skippedReason?: string
}
export type CorrectionPushResult = { head: string; raw: Json; contributionIds: string[] }

export type NativeCorrectionPort = Pick<NativeBatchController, 'activate' | 'active' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
}

export type BoundCorrectionAction = {
  /** The action inventory is already published and bound when this batch is returned. */
  batch: NativeBatch
  /** Persists every known and unknown child before any executor interpretation. */
  conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
}

export type CorrectionActionBinding = {
  phase: 'apply' | 'falsify' | 'restore-proof' | 'revalidate'
  causeId: string
  task: NativeTask
  /** Exact persisted record references; later actions append confirmed native contribution IDs. */
  contextRefs: readonly string[]
  /** Transient immutable semantic view included in the native task; durable links are contextRefs. */
  context: Json
}

export type NativeCorrectionExecutionOptions = {
  native: NativeCorrectionPort
  prepared: Pick<PreparedFix, 'cwd' | 'target' | 'publishBinding'>
  operationId: string
  /** Re-check the already bound authority before any correction action or push. */
  authorizeContinuation?(): Promise<{ ok: true; value: undefined } | { ok: false; diagnostics: string[] }>
  decisionId: string
  signal: AbortSignal
  /** Creates and confirms one action-specific inventory before dispatch. */
  bindAction(input: CorrectionActionBinding): Promise<CorrectionEffectResult<BoundCorrectionAction>>
  /** FixRun records the first review-bound action only after its exact batch is armed. */
  onStarted(batch: NativeBatch, binding: CorrectionActionBinding): Promise<CorrectionEffectResult<void>>
}

export type NativeDispatchResult = { native: NativeBatchResult; contributionIds: string[] }
