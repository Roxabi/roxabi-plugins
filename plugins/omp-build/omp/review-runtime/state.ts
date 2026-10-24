import type { Submission } from '../../contracts'
import type { Json, NativeBatch, NativeBatchCallbacks, NativeProofBashCall, NativeTaskWireInput } from './contracts'

export type YieldRaw = {
  toolCallId: string
  contentIndex: number | null
  argumentDeltas: string[]
  argumentText: string
  rawBlock: string | null
  toolCallArguments: Json | null
  executionArguments: Json | null
}

export type ChildCapture = {
  deltasByContentIndex: Map<number, string[]>
  textDeltas: string[]
  pendingCalls: Map<string, YieldRaw>
  pendingProofCalls: Map<string, { input: Json; effectiveCwd: string | null }>
  completedProofCalls: Map<string, NativeProofBashCall>
  ambiguousProofCallIds: Set<string>
  pendingBashCalls: Map<string, { input: Json; effectiveCwd: string | null }>
  completedBashCalls: Map<string, NativeProofBashCall>
  conflictingBashCalls: NativeProofBashCall[]
  ambiguousBashCallIds: Set<string>
  submissions: Submission[]
  partialText: string | null
}

export type ActiveBatch = {
  batch: NativeBatch
  wire: NativeTaskWireInput
  callbacks: NativeBatchCallbacks
  defaultCwd: string | null
  admittedToolCallId: string | null
  spawnedIndexes: Set<number>
  announced: boolean
  announcementDispatched: boolean
  settling: boolean
  abortCleanup: (() => void) | null
  captures: Map<string, ChildCapture>
}

function nativeTaskInput(batch: NativeBatch): NativeTaskWireInput {
  return {
    context: batch.tasks.context,
    tasks: batch.tasks.tasks.map(({ proofEvidence: _proofEvidence, ...task }) => task),
  }
}

export function createActiveBatch(
  batch: NativeBatch,
  callbacks: NativeBatchCallbacks,
  defaultCwd: string | null,
): ActiveBatch {
  return {
    batch,
    wire: nativeTaskInput(batch),
    callbacks,
    defaultCwd,
    admittedToolCallId: null,
    spawnedIndexes: new Set(),
    announced: false,
    announcementDispatched: false,
    settling: false,
    abortCleanup: null,
    captures: new Map(),
  }
}
