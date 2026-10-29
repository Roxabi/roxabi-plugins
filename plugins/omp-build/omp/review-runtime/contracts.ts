import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import type { Json, Submission } from '../../contracts'
import type { ContextActionBinding, MissingContextItem } from '../../engine/action-context.ts'
import type { CommandRun, EvidenceProvenance } from '../../engine/criterion-evidence-schema.ts'
import type { PreparedUwAction } from '../../roxabi/uw-action-contract.ts'

export type { Json, Submission }

export type NativeProofDirective = {
  purpose: 'fix-apply' | 'fix-revalidate' | 'fix-falsify'
  causeId: string
  occurrence: 'apply' | 'perturbed' | 'restored'
}

export type NativeTask = {
  name: string
  agent: string
  task: string
  solutionSpace: string
  /** Host-only proof contract; stripped from the native task wire input. */
  proofEvidence?: NativeProofDirective
  /** Host-only registered snapshot. Required on an execution task; never sent on the task wire. */
  action: PreparedUwAction
}
/** A host-prepared batch; the model receives only its opaque selector. */
export type NativeBatch = {
  operationId: string
  tasks: { context: string; tasks: NativeTask[] }
}

export type NativeTaskWireInput = { batchId: string }

/** Actual SDK executor outcomes, not an invented SDK tool-result event. */
export type NativeExecutionObservation = {
  toolCallId: string
  results: unknown[]
  errors: string[]
}

export type NativeProofBashCall = {
  toolCallId: string
  /** Original public Bash arguments, unchanged. */
  input: Json
  /** Directory used for host git probes. Adapter-derived from the call arguments and session default, not an SDK-observed execution cwd. */
  effectiveCwd: string | null
  result: Json | null
  exitCode: number | null
}

export type NativeProofEvidence = NativeProofDirective & {
  guardId: string | null
  call: NativeProofBashCall | null
}

export type NativeChildResult = {
  /** Native task result identity; never synthesized for an absent child. */
  id: string | null
  /** Host-authorized task name expected at this position, if one exists. */
  expectedId: string | null
  /** Every observed `yield` call, in child-local execution order. */
  submissions: Submission[]
  /** Narrow actual native Bash evidence for an explicitly declared fix proof only. */
  proofEvidence: NativeProofEvidence | null
  /** Referenced Bash calls only, including conflicting captures of those IDs. Unreferenced calls stay ephemeral. */
  bashCalls?: readonly NativeProofBashCall[]
  /** Grounded runs only. Unobserved code identity is omitted, never invented. */
  commandRuns?: readonly CommandRun[]
  /** Actual matched child/yield identity for non-test observations; not an assertion of their truth. */
  observationProvenance?: Extract<EvidenceProvenance, { kind: 'native' }>
  nativeProvenance?: Extract<EvidenceProvenance, { kind: 'native' }>
  /** Exact terminal native child result, or null when no child result arrived. */
  raw: Json
  partialText: string | null
  /** The native final structured value only after strict terminal validation. */
  structured: Json | null
  /** Host-authenticated missing-context result and its exact sealed action. */
  contextBlock?: { missing: readonly MissingContextItem[]; action: ContextActionBinding }
  /** Revocable host-only permission to conserve this negative batch, never model output. */
  canPublishContext?: () => boolean
  usable: boolean
  reason: string | null
}

export type NativeBatchResult = {
  batch: NativeBatch
  children: NativeChildResult[]
  /** Revocable host-only permission to conserve this negative batch, never positive continuation. */
  canPublishContext?: () => boolean
  raw: Json
  complete: boolean
}

export type NativeBatchCallbacks = {
  /** Called once for each terminal or missing native child result before product interpretation. */
  onChildResult?: (child: NativeChildResult) => void | Promise<void>
  /** Called only after every required child reaches a strict valid terminal result. */
  onComplete: (result: NativeBatchResult, canContinue: () => boolean) => void | Promise<void>
  /** Called once after onComplete resolves. agent_end does not invoke this. */
  onSettled?: (result: NativeBatchResult, canContinue: () => boolean) => void | Promise<void>
  onStop: (reason: string, result: NativeBatchResult | null) => void | Promise<void>
}

/** The public SDK extension surface used by this bridge. */
export type NativeExtension = Pick<
  ExtensionAPI,
  | 'on'
  | 'registerTool'
  | 'sendUserMessage'
  | 'sendMessage'
  | 'getActiveTools'
  | 'getAllTools'
  | 'setActiveTools'
  | 'events'
>
