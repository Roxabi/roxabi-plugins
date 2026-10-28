import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import type { Json, Submission } from '../../contracts'

export type { Json }

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
  /** Parent Eval-defined tool names to inject; child built-ins are pinned by the agent profile. */
  tools?: string[]
  /** Host-only proof contract; stripped from the native task wire input. */
  proofEvidence?: NativeProofDirective
}

/** Exact native `task.batch` request guarded by the extension. */
export type NativeBatch = {
  operationId: string
  tasks: { context: string; tasks: NativeTask[] }
}

/**
 * Execution-authority `task.batch` args for one authorized native batch.
 * Compared strictly at the native `tool_call` hook after the SDK strips harness intent `i`.
 * Model-facing announce adds `i` only at the announcement boundary — never stored on this object.
 */
export type NativeTaskWireInput = {
  context: string
  tasks: Array<Omit<NativeTask, 'proofEvidence'>>
}

export const NATIVE_TASK_INTENT = 'omp-build native batch'

export type NativeProofBashCall = {
  toolCallId: string
  /** Original public Bash arguments, unchanged. */
  input: Json
  /** SDK-resolved host cwd, or null when the observed call cannot be resolved. */
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
  /** Exact terminal native child result, or null when no child result arrived. */
  raw: Json
  partialText: string | null
  /** The native final structured value only after strict terminal validation. */
  structured: Json | null
  usable: boolean
  reason: string | null
}

export type NativeBatchResult = {
  batch: NativeBatch
  children: NativeChildResult[]
  raw: Json
  complete: boolean
}

export type NativeBatchCallbacks = {
  /** Called once for each terminal or missing native child result before product interpretation. */
  onChildResult?: (child: NativeChildResult) => void | Promise<void>
  /** Called only after every required child reaches a strict valid terminal result. */
  onComplete: (result: NativeBatchResult) => void | Promise<void>
  /** Called once after onComplete resolves. agent_end does not invoke this. */
  onSettled?: (result: NativeBatchResult) => void | Promise<void>
  onStop: (reason: string, result: NativeBatchResult | null) => void | Promise<void>
}

/** The public SDK extension surface used by this bridge; no private runner APIs. */
export type NativeExtension = Pick<ExtensionAPI, 'on' | 'sendUserMessage'> & {
  events: Pick<ExtensionAPI['events'], 'on'>
}
