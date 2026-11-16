import { randomUUID } from 'node:crypto'
import type { FixActionResult, FixIdentity, FixRecord, NativePort } from './fix-contract.ts'
import { runDefaultFix } from './fix-entry-default.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { fail } from './fix-entry-target-core.ts'
import { FixExecutionFence } from './fix-execution-fence.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'

export type FixStart =
  | { status: 'accepted'; runId: string; operationId: string }
  | { status: 'terminal'; result: FixActionResult<FixRecord> }

export type FixTerminal =
  | { status: 'complete'; recordId: string; kind: 'fix-result' }
  | { status: 'stopped'; diagnostics: string[] }

export type FixRun = {
  runId: string
  operationId: string
  started: Promise<FixStart>
  completion: Promise<FixActionResult<FixRecord>>
  /** Settles only when the tracked driver has actually terminated, including after stop. */
  driverTerminated: Promise<void>
  executionFence: FixExecutionFence
  terminal: Promise<FixTerminal>
  stop(reason: string): Promise<void>
}
export function createIdentity(
  runId = `fix-${randomUUID()}`,
  operationId = `fix-operation-${randomUUID()}`,
): FixIdentity {
  let sequence = 0
  return {
    runId,
    operationId,
    nextRecordId(kind) {
      sequence += 1
      return `${runId}-${kind}-${sequence}`
    },
  }
}
type FixRunInput = {
  identity?: FixIdentity
  native: NativePort
  operations: DefaultFixEntry['operations']
  drive(identity: FixIdentity, runtime: FixWorkflowRuntime): Promise<FixActionResult<FixRecord>>
}

export function startDefaultFix(input: DefaultFixEntry): FixRun {
  return startFixRun({
    native: input.native,
    operations: input.operations,
    drive: (identity, runtime) => runDefaultFix(input, identity, runtime),
  })
}

export function startFixRun(input: FixRunInput): FixRun {
  const identity = input.identity ?? createIdentity()
  const executionFence = input.native.executionFence ?? new FixExecutionFence()
  executionFence.bindIdentity(identity)
  const started = Promise.withResolvers<FixStart>()
  const completed = Promise.withResolvers<FixActionResult<FixRecord>>()
  const controller = new AbortController()
  let inhibit: 'pause' | null = null
  let continueBound: (() => Promise<FixActionResult<void>>) | null = null
  let stopped = false
  let startSettled = false
  let completionSettled = false
  let activeBatch: Parameters<NativePort['announce']>[0] | null = null
  let stopping: Promise<void> | null = null
  const settleStarted = (value: FixStart) => {
    if (!startSettled) {
      startSettled = true
      started.resolve(value)
    }
  }
  const settleCompletion = (value: FixActionResult<FixRecord>) => {
    if (!completionSettled) {
      completionSettled = true
      completed.resolve(value)
    }
  }
  const runtime: FixWorkflowRuntime = {
    signal: controller.signal,
    uw: input.operations,
    executionFence,
    onBatch(batch) {
      activeBatch = batch
    },
    onStarted() {
      if (!stopped) settleStarted({ status: 'accepted', runId: identity.runId, operationId: identity.operationId })
    },
    async beforeContinuation() {
      if (inhibit !== null || controller.signal.aborted) return fail('fix-mandate-refused:unconfirmed')
      if (continueBound === null) return fail('fix-mandate-authority-unavailable')
      const allowed = await continueBound()
      return inhibit !== null || controller.signal.aborted ? fail('fix-mandate-refused:unconfirmed') : allowed
    },
    bindContinuation(check) {
      continueBound = check
    },
  }
  const driver = Promise.resolve()
    .then(() =>
      controller.signal.aborted
        ? fail<FixRecord>('fix-run-interrupted-cleanup-unproven')
        : input.drive(identity, runtime),
    )
    .then((result) => {
      executionFence.finishDriver(
        result.ok && result.value.kind === 'fix-result' ? 'canonical-result' : 'nonterminal-result',
      )
      if (stopped) return
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
    .catch((error) => {
      executionFence.finishDriver('threw')
      if (stopped) return
      const result = fail<FixRecord>(`fix-run-failed:${error instanceof Error ? error.message : String(error)}`)
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
  return {
    runId: identity.runId,
    operationId: identity.operationId,
    started: started.promise,
    completion: completed.promise,
    driverTerminated: driver,
    executionFence,
    terminal: completed.promise.then((result) =>
      result.ok && result.value.kind === 'fix-result'
        ? { status: 'complete', recordId: result.value.recordId, kind: 'fix-result' }
        : { status: 'stopped', diagnostics: result.ok ? ['fix-terminal-not-result'] : result.diagnostics },
    ),
    stop(reason) {
      if (stopping !== null) return stopping
      try {
        executionFence.beginStop()
      } catch (error) {
        return Promise.reject(error)
      }
      const joined = Promise.withResolvers<void>()
      stopping = joined.promise
      executionFence.seal()
      inhibit = 'pause'
      stopped = true
      let archival: Promise<void>
      try {
        archival = activeBatch === null ? Promise.resolve() : input.native.stopOwned(activeBatch, reason)
      } catch (error) {
        archival = Promise.reject(error)
      }
      controller.abort()
      const result = fail<FixRecord>(`fix-run-interrupted-cleanup-unproven:${reason}`)
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
      void Promise.allSettled([driver, archival])
        .then(async (results) => {
          await executionFence.joinCallbacks()
          await executionFence.joinPublications()
          for (const result of results) {
            if (result.status === 'rejected') {
              executionFence.finishStop(false)
              joined.reject(result.reason)
              return
            }
          }
          executionFence.finishStop(true)
          joined.resolve()
        })
        .catch((error) => {
          executionFence.finishStop(false)
          joined.reject(error)
        })
      return stopping
    },
  }
}
