import type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import type { FixActionResult, NativePort } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { UwOperations } from './uw-contract.ts'

export function actionTask(
  name: string,
  agent: string,
  task: string,
  solutionSpace: string,
  proofEvidence?: NativeTask['proofEvidence'],
): Omit<NativeTask, 'action'> {
  return { name, agent, task, solutionSpace, ...(proofEvidence === undefined ? {} : { proofEvidence }) }
}

export type FixWorkflowRuntime = {
  signal: AbortSignal
  uw: UwOperations
  onBatch(batch: NativeBatch): void
  onStarted(batch: NativeBatch): void
  /** Re-read authority before the next native dispatch. A refusal inhibits that continuation only. */
  beforeContinuation?(): Promise<FixActionResult<void>>
  bindContinuation?(check: () => Promise<FixActionResult<void>>): void
}

export function stopped<T>(runtime: FixWorkflowRuntime): FixActionResult<T> | null {
  return runtime.signal.aborted ? failure('fix-run-interrupted-cleanup-unproven') : null
}

function conservationFailure(error: unknown): FixActionResult<never> {
  const detail = error instanceof Error ? error.message : String(error)
  return failure(`native-batch-conservation-failed:${detail}`)
}

async function conserveNativeResult<T>(
  conserve: (result: NativeBatchResult) => Promise<FixActionResult<T>>,
  settle: (value: FixActionResult<T>) => void,
  result: NativeBatchResult,
  terminal?: FixActionResult<T>,
): Promise<void> {
  try {
    const conserved = await conserve(result)
    if (!conserved.ok) {
      settle(conserved)
      throw new Error(`native-batch-conservation-failed:${conserved.diagnostics.join(';')}`)
    }
    settle(terminal ?? conserved)
  } catch (error) {
    settle(conservationFailure(error))
    throw error
  }
}

async function conserveStoppedResult<T>(
  conserve: (result: NativeBatchResult) => Promise<FixActionResult<T>>,
  settle: (value: FixActionResult<T>) => void,
  reason: string,
  result: NativeBatchResult | null,
): Promise<void> {
  if (result === null) {
    settle(failure(`native-batch-stopped:${reason}`))
    return
  }
  await conserveNativeResult(conserve, settle, result, failure(`native-batch-stopped:${reason}`))
}

function preflightNativeActivation<T>(native: NativePort, runtime: FixWorkflowRuntime): FixActionResult<T> | null {
  const stillFenced = stopped<T>(runtime)
  if (stillFenced) return stillFenced
  return native.active() === null ? null : failure('native-batch-already-active')
}

async function preflightNativeContinuation<T>(
  native: NativePort,
  runtime: FixWorkflowRuntime,
  beforeContinuation: NonNullable<FixWorkflowRuntime['beforeContinuation']>,
): Promise<FixActionResult<T> | null> {
  const allowed = await beforeContinuation()
  if (!allowed.ok) return allowed
  return preflightNativeActivation<T>(native, runtime)
}

async function preflightNativeDispatch<T>(
  native: NativePort,
  runtime: FixWorkflowRuntime,
): Promise<FixActionResult<T> | null> {
  const fenced = stopped<T>(runtime)
  if (fenced) return fenced
  const beforeContinuation = runtime.beforeContinuation
  return beforeContinuation === undefined
    ? preflightNativeActivation<T>(native, runtime)
    : preflightNativeContinuation<T>(native, runtime, beforeContinuation)
}

async function activateAndAnnounceNativeBatch<T>(
  native: NativePort,
  batch: NativeBatch,
  runtime: FixWorkflowRuntime,
  conserve: (result: NativeBatchResult) => Promise<FixActionResult<T>>,
  settle: (value: FixActionResult<T>) => void,
  aborted: Promise<void>,
): Promise<FixActionResult<T> | null> {
  try {
    native.activate(batch, {
      onComplete: (result, canContinue) => {
        if (!canContinue()) return
        return conserveNativeResult(
          conserve,
          settle,
          result,
          result.children.some((child) => child.contextBlock !== undefined)
            ? failure('native-batch-stopped:action-context-missing')
            : undefined,
        )
      },
      onStop: (reason, result) => conserveStoppedResult(conserve, settle, reason, result),
    })
    runtime.onBatch(batch)
    if (runtime.signal.aborted) {
      void native.stopOwned(batch, 'fix-run-interrupted').catch(() => undefined)
      return failure('fix-run-interrupted-cleanup-unproven')
    }
    const announced = native.announce(batch)
    void announced.catch(() => undefined)
    await Promise.race([announced, aborted])
    return stopped<T>(runtime)
  } catch (error) {
    const announcement = `native-batch-announce-failed:${error instanceof Error ? error.message : String(error)}`
    try {
      await native.stopOwned(batch, 'native-batch-announce-failed')
    } catch (archival) {
      return failure(
        announcement,
        `native-batch-archive-failed:${archival instanceof Error ? archival.message : String(archival)}`,
      )
    }
    return failure(announcement)
  }
}

export async function dispatchNativeBatch<T>(
  native: NativePort,
  batch: NativeBatch,
  runtime: FixWorkflowRuntime,
  conserve: (result: NativeBatchResult) => Promise<FixActionResult<T>>,
  accept: boolean,
): Promise<FixActionResult<T>> {
  const refusal = await preflightNativeDispatch<T>(native, runtime)
  if (refusal) return refusal
  const deferred = Promise.withResolvers<FixActionResult<T>>()
  const aborted = Promise.withResolvers<void>()
  let settled = false
  const settle = (value: FixActionResult<T>) => {
    if (!settled) {
      settled = true
      deferred.resolve(value)
    }
  }
  const onAbort = () => {
    settle(failure('fix-run-interrupted-cleanup-unproven'))
    aborted.resolve()
  }
  runtime.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const activation = await activateAndAnnounceNativeBatch(native, batch, runtime, conserve, settle, aborted.promise)
    if (activation) return activation
    if (accept) runtime.onStarted(batch)
    return await deferred.promise
  } finally {
    runtime.signal.removeEventListener('abort', onAbort)
  }
}
