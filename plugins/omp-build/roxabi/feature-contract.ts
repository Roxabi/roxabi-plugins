import type { Gh } from '../adapters/github/types.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Diagnostic } from '../engine/record-values.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { AcceptedChildCommitment } from '../engine/workflow-mandate-schema.ts'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { PreparedEpicReview } from './epic-range-finalization.ts'
import type { NormalizationProposalRequest, UwOperations, UwReadPort } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type FeatureControl = 'select' | 'continue' | 'resume' | 'pause' | 'abandon' | 'new' | 'material-decision'
export type FeatureSessionReason = 'session-stop' | 'session-switch' | 'session-shutdown'

export type FeatureNativePort = {
  activate(batch: NativeBatch, callbacks: NativeBatchCallbacks): void
  inactive(): void
  stopOwned(batch: NativeBatch, reason: string): Promise<void>
  announce(batch: NativeBatch): Promise<void>
}

export type FeatureFixTerminal =
  | { status: 'complete'; recordId: string; kind: 'fix-result' }
  | { status: 'stopped'; diagnostics: string[] }

export type FeatureReviewFix = {
  reference: string
  reviewId: string
  scope: string
  requiredFeatureMandate: ScopedRecordRef & { kind: 'mandate' }
}

export type ContinueFeatureResult =
  | { kind: 'action'; node: string; followUp: NativeBatch; start: ScopedRecordRef }
  | { kind: 'watch'; command: string }
  | { kind: 'epic-final-review'; review: PreparedEpicReview }
  | { kind: 'review'; pr: number }
  | ({ kind: 'fix' } & FeatureReviewFix)
  | {
      kind: 'admitted-ci-correction'
      reference: string
      attributionRecordId: string
      uw: { ownSpec: AcceptedOwnSpec; children: readonly AcceptedChildCommitment[] }
    }
  | { kind: 'blocked'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'paused'; confirmed: boolean; reason: string }
  | { kind: 'abandoned'; confirmed: boolean }
  | { kind: 'terminal'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'session-cwd'; path: string; instruction: string }
  | { kind: 'operator-decision'; reason: string }
  | { kind: 'normalization'; request: NormalizationProposalRequest }

export type ContinueFeatureInput = {
  cwd: string
  reference: string
  control: FeatureControl
  principal: boolean
  git?: GitRunner
  gh?: Gh
  uw?: UwOperations
  read?: UwReadPort
}

export type FeatureSessionPauseInput = {
  cwd: string
  reason: FeatureSessionReason
  interrupt: (operationId: 'session') => Promise<void>
  reference?: string
  gh?: Gh
}

export type FeatureNativePublication =
  | { published: true; retained: true }
  | { published: false; retained: true; reason: string }
  | { published: false; retained: false; reason: string }

export type FeatureWorkflow = {
  continueFeature(input: ContinueFeatureInput): Promise<ContinueFeatureResult>
  consumeWatchExit(input: {
    cwd: string
    pr: number
    code: number
    reference: string
    gh?: Gh
    git?: GitRunner
  }): Promise<ContinueFeatureResult>
  publishFeatureNativeResult(input: {
    cwd: string
    result: NativeBatchResult
    start: ScopedRecordRef
    startHead?: string
    git?: GitRunner
    gh?: Gh
  }): Promise<FeatureNativePublication>
  requestFeatureSessionPause(input: FeatureSessionPauseInput): Promise<ContinueFeatureResult>
}

export type ParsedFeatureCommand =
  | { ok: true; control: FeatureControl; reference: string }
  | { ok: true; control: 'init'; args: readonly string[] }
  | { ok: false; reason: string }

export type FeatureCommandHost = {
  key: object
  cwd: string
  principal: boolean
  workflow: FeatureWorkflow
  native: FeatureNativePort
  send: (text: string) => Promise<void>
  inhibitFeatureContinuation: () => void
  releaseFeatureContinuation: () => void
  featureContinuationInhibited: () => boolean
  markFeatureBatch: (batch: NativeBatch) => void
  startReview?: (args: string, onComplete: () => Promise<void>) => Promise<void>
  startFix?: (input: FeatureReviewFix) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
  /** Command-context UW capability: absent only when the installed UW composition is unavailable. */
  uw?: UwOperations
  startAdmittedCiCorrection?: (input: {
    reference: string
    attributionRecordId: string
    uw: { ownSpec: AcceptedOwnSpec; children: readonly AcceptedChildCommitment[] }
  }) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
  prepareEpicRangeReview?: (review: PreparedEpicReview, onComplete: () => Promise<void>) => Promise<void>
  git?: FeatureGit
  interruptOwnedWork?: (reason: string) => Promise<void>
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ code: number; killed: boolean; stdout?: string; stderr?: string }>
}

export type FeatureGit = (args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>
