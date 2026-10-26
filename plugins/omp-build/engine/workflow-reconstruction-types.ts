import type { ExternalRecordRef, ProofConfigPin } from './record-references.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { PauseBinding } from './workflow-control.ts'
import type { WorkflowGraphAction } from './workflow-graph.ts'

export type WorkflowBlockReason =
  | 'mandate-absent'
  | 'pause-unconfirmed'
  | 'spec-decision-required'
  | 'config-drift'
  | 'proof-pin-drift'
  | 'unsupported-config'
  | 'action-uncertain'
  | 'unknown-outcome'
  | 'ambiguous-transition'
  | 'session-cwd'
  | 'fix-only'
  | 'ci-attribution-required'
  | 'successor-required'
  | 'unsafe-authority'
  | 'cycle'
  | 'unsupported-graph'
  | 'unconfirmed'
  | 'incomplete'
  | 'missing-history'
  | 'unknown-binding'
  | 'missing-contribution'
export type WorkflowDecision =
  | {
      status: 'action'
      action: WorkflowGraphAction
      nodeId: string | null
      mandateId: string | null
      evidence: Diagnostic[]
    }
  | {
      status: 'action'
      action: 'resume'
      nodeId: null
      mandateId: string
      evidence: Diagnostic[]
      pause: PauseBinding
    }
  | { status: 'blocked'; reason: WorkflowBlockReason; evidence: Diagnostic[] }
  | { status: 'paused'; mandateId: string; confirmed: true; evidence: Diagnostic[]; pause?: PauseBinding }
  | { status: 'abandoned'; mandateId: string; evidence: Diagnostic[] }
  | {
      status: 'terminal'
      reason: 'stop' | 'done' | 'spec-ambiguous' | 'ci-attribution-refused' | 'bound-stop' | 'abandoned'
      evidence: Diagnostic[]
    }

export type WorkflowFacts = {
  specDigest: string | null
  specBody: string | null
  branch: string | null
  base: string | null
  candidateGitSHA: string | null
  pullRequest: { scope: Scope; head: string; base: string; associatedIssue: Scope | null } | null
  merged: boolean
  sessionCwd: string | null
  preparedWorktree: string | null
  productVersion: string
  configVersion: string
  configDigest: string
  supportedConfigVersions: readonly string[]
  proofPins: readonly ProofConfigPin[]
  explicitSelection: boolean
  explicitResume: boolean
  successorAntecedent: ExternalRecordRef | null
  endObligationsMet: boolean
  localInhibit: 'pause' | 'abandon' | null
  /** Display names only. Omitted or empty is not current CI evidence. */
  failedChecks?: readonly string[] | null
  /** Digest from failedCheckEvidenceDigest of the current native failures. Omitted or null cannot authorize fix. */
  evidenceDigest?: string | null
}

export type NativeSelectorStatus = 'absent' | 'published' | 'uncertain' | 'failed' | 'not-applicable'
export type NativeSelector = { status: NativeSelectorStatus; evidence: Diagnostic[] }
export type SpecializedDecisions = {
  reviewStep: 'review' | 'fix' | 'land' | 'stop' | null
  epicStep: 'start' | 'resume' | 'stop' | 'final-review' | 'fix-ticket' | 'post-merge' | 'complete' | 'drop' | null
  epicLand: boolean | null
  ciWatchStatus: 'green' | 'red' | 'pending' | 'timeout' | 'behind' | 'unknown' | null
  publish: NativeSelector
  landing: NativeSelector
  watch: NativeSelector
}
