import { randomUUID } from 'node:crypto'
import type { FixActionResult, FixIdentity, FixRecord, NativePort } from './fix-contract.ts'
import { runDefaultFix } from './fix-entry-default.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { fail } from './fix-entry-target-core.ts'
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
export function startDefaultFix(input: DefaultFixEntry): FixRun {
  const identity = createIdentity()
  const started = Promise.withResolvers<FixStart>()
  const completed = Promise.withResolvers<FixActionResult<FixRecord>>()
  const controller = new AbortController()
  let inhibit: 'pause' | null = null
  let continueBound: (() => Promise<FixActionResult<void>>) | null = null
  let stopped = false
  let startSettled = false
  let completionSettled = false
  let activeBatch: Parameters<NativePort['announce']>[0] | null = null
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
  void runDefaultFix(input, identity, runtime)
    .then((result) => {
      if (stopped) return
      settleStarted({ status: 'terminal', result })
      settleCompletion(result)
    })
    .catch((error) => {
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
    terminal: completed.promise.then((result) =>
      result.ok && result.value.kind === 'fix-result'
        ? { status: 'complete', recordId: result.value.recordId, kind: 'fix-result' }
        : { status: 'stopped', diagnostics: result.ok ? ['fix-terminal-not-result'] : result.diagnostics },
    ),
    async stop(reason) {
      if (stopped) return
      inhibit = 'pause'
      stopped = true
      let archival: Promise<void> | null = null
      try {
        if (activeBatch !== null) archival = input.native.stopOwned(activeBatch, reason)
      } finally {
        controller.abort()
        const result = fail<FixRecord>(`fix-run-interrupted-cleanup-unproven:${reason}`)
        settleStarted({ status: 'terminal', result })
        settleCompletion(result)
      }
      if (archival !== null) await archival
    },
  }
}
