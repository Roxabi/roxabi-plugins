import { randomUUID } from 'node:crypto'
import type { ActionCommunication } from '../action-communication.ts'
import type {
  Json,
  NativeBatch,
  NativeBatchCallbacks,
  NativeProofBashCall,
  NativeTaskWireInput,
  Submission,
} from './contracts'
import type { HostGitObserver } from './host-git-observation.ts'
export type YieldRaw = {
  toolCallId: string
  contentIndex: number | null
  argumentDeltas: string[]
  argumentText: string
  rawBlock: string | null
  toolCallArguments: Json | null
  executionArguments: Json | null
}
export type HostGitBoundary = { repository: string; commit: string; tree: string } | null
export type HostGitSpan = { start: HostGitBoundary; end: HostGitBoundary }

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
  hostGit: Map<string, HostGitSpan>
}

export type ActiveBatch = {
  batch: NativeBatch
  wire: NativeTaskWireInput
  callbacks: NativeBatchCallbacks
  defaultCwd: string | null
  artifactsDir: string | null
  admittedToolCallId: string | null
  executionAbort: AbortController | null
  executionDone: Promise<void> | null
  finishExecution: (() => void) | null
  spawnedIndexes: Set<number>
  models: Array<{ provider: string; id: string }>
  announced: boolean
  announcementDispatched: boolean
  settling: boolean
  continuationClosed: string | null
  contextPublicationOwned: boolean
  retentionFailed: string | null
  childSlots: Map<string, number>
  /** Actual child callbacks, never public observability frames, establish these bindings. */
  guardedChildren: Map<string, { sessionId: string; valid: boolean; yieldData: Json | null }>
  starts: Map<
    string,
    {
      index: number
      sessionFile: string
      task: NativeBatch['tasks']['tasks'][number]
      action: NativeBatch['tasks']['tasks'][number]['action']
      snapshot: NativeBatch['tasks']['tasks'][number]['action']['snapshot']
      inputs: NativeBatch['tasks']['tasks'][number]['action']['inputs']
      closed: boolean
    } | null
  >
  communication: ActionCommunication | null
  retainedResultRef: string | null
  abortCleanup: (() => void) | null
  captures: Map<string, ChildCapture>
  observeHostGit: HostGitObserver
}
function nativeTaskInput(): NativeTaskWireInput {
  return { batchId: randomUUID() }
}

export function createActiveBatch(
  batch: NativeBatch,
  callbacks: NativeBatchCallbacks,
  defaultCwd: string | null,
  artifactsDir: string | null,
  observeHostGit: HostGitObserver,
): ActiveBatch {
  return {
    batch,
    wire: nativeTaskInput(),
    callbacks,
    defaultCwd,
    artifactsDir,
    admittedToolCallId: null,
    executionAbort: null,
    executionDone: null,
    finishExecution: null,
    models: [],
    spawnedIndexes: new Set(),
    announced: false,
    announcementDispatched: false,
    settling: false,
    continuationClosed: null,
    contextPublicationOwned: false,
    retentionFailed: null,
    childSlots: new Map(),
    communication: null,
    guardedChildren: new Map(),
    starts: new Map(),
    retainedResultRef: null,
    abortCleanup: null,
    captures: new Map(),
    observeHostGit,
  }
}

export function spawnRefusal(
  active: ActiveBatch,
  spawn: { invocationKind: string; agent: string; spawnKey?: string },
): string | null {
  if (active.settling) return 'native batch is settling'
  if (active.admittedToolCallId === null) {
    return 'native subagent spawn occurred before the host-authorized task call'
  }
  if (spawn.invocationKind !== 'task') {
    return 'native subagent spawn is outside the host-authorized task invocation'
  }
  const spawnKey = spawn.spawnKey
  if (spawnKey === undefined) return 'native subagent spawn lacks its native task identity'
  const index = active.childSlots.get(spawnKey)
  if (index === undefined) return 'native subagent spawn does not match one authorized native task identity'
  const expected = active.batch.tasks.tasks[index]
  if (expected === undefined || expected.agent !== spawn.agent || active.spawnedIndexes.has(index)) {
    return 'native subagent spawn does not match an authorized native task identity'
  }
  active.spawnedIndexes.add(index)
  return null
}

/** Retain a stop-signal watcher until the batch's terminal work finishes. */
export function watchBatchSettleAbort(active: ActiveBatch, signal: AbortSignal, onAbort: () => void): void {
  active.abortCleanup?.()
  active.abortCleanup = () => signal.removeEventListener('abort', onAbort)
  signal.addEventListener('abort', onAbort, { once: true })
}

export function clearBatchSettleAbort(active: ActiveBatch): void {
  active.abortCleanup?.()
  active.abortCleanup = null
}

/** Track terminal work and release only the matching batch when it settles. */
export function rememberBatchTerminal(
  terminals: WeakMap<NativeBatch, Promise<void>>,
  live: Set<ActiveBatch>,
  batch: NativeBatch,
  terminal: Promise<void>,
): void {
  terminals.set(batch, terminal)
  const forget = (): void => {
    if (terminals.get(batch) === terminal) terminals.delete(batch)
    for (const active of live) {
      if (active.batch !== batch) continue
      clearBatchSettleAbort(active)
      live.delete(active)
    }
  }
  void terminal.then(forget, forget)
}
