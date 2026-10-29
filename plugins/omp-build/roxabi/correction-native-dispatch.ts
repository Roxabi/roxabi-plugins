import { isDeepStrictEqual } from 'node:util'
import type { NativeBatchCallbacks } from '../omp/review-runtime/contracts.js'
import { failed } from './correction-action'
import type {
  CorrectionActionBinding,
  CorrectionEffectResult,
  NativeCorrectionExecutionOptions,
  NativeDispatchResult,
} from './correction-execution-contract'

export type NativeDispatchDependencies = Pick<
  NativeCorrectionExecutionOptions,
  'native' | 'operationId' | 'signal' | 'authorizeContinuation' | 'bindAction' | 'onStarted'
>

/**
 * Arms one already-authorized native action. A terminal native result is conserved
 * exactly once before anything returns it to an interpreter.
 */
export async function dispatchCorrectionAction(
  options: NativeDispatchDependencies,
  binding: CorrectionActionBinding,
): Promise<CorrectionEffectResult<NativeDispatchResult>> {
  const abortFence = <T>(): CorrectionEffectResult<T> | null =>
    options.signal.aborted ? failed('terminal', 'fix-run-aborted') : null
  const fence = abortFence<NativeDispatchResult>()
  if (fence) return fence
  const authorized = await options.authorizeContinuation?.()
  if (authorized !== undefined && !authorized.ok)
    return {
      ok: false,
      kind: 'terminal',
      diagnostics: authorized.diagnostics,
      preEffectRefusal: authorized.diagnostics,
    }
  const stillFenced = abortFence<NativeDispatchResult>()
  if (stillFenced) return stillFenced
  const bound = await options.bindAction(binding)
  if (!bound.ok) return bound
  const { batch } = bound.value
  if (
    batch.operationId !== options.operationId ||
    batch.tasks.tasks.length !== 1 ||
    !isDeepStrictEqual(batch.tasks.tasks[0], binding.task) ||
    options.native.active() !== null
  )
    return failed('terminal', 'native-action-binding-invalid')

  const deferred = Promise.withResolvers<CorrectionEffectResult<NativeDispatchResult>>()
  const announcementAborted = Promise.withResolvers<void>()
  let settled = false
  let conserved = false
  const settle = (value: CorrectionEffectResult<NativeDispatchResult>): void => {
    if (settled) return
    settled = true
    deferred.resolve(value)
  }
  const conserve = async (
    result: Parameters<NativeBatchCallbacks['onComplete']>[0],
    terminal: CorrectionEffectResult<NativeDispatchResult>,
  ): Promise<void> => {
    if (conserved) return
    conserved = true
    try {
      const preserved = await bound.value.conserve(result)
      if (!preserved.ok) {
        settle(failed('terminal', ...preserved.diagnostics))
        throw new Error(`native-action-conservation-failed:${preserved.diagnostics.join(';')}`)
      }
      if (
        preserved.value.contributionIds.length === 0 ||
        preserved.value.contributionIds.some((id) => id.trim().length === 0)
      ) {
        settle(failed('terminal', 'native-action-contribution-ids-missing'))
        throw new Error('native-action-contribution-ids-missing')
      }
      settle(
        terminal.ok
          ? {
              ok: true,
              value: {
                native: result,
                contributionIds: preserved.value.contributionIds,
                records: preserved.value.records ?? [],
              },
            }
          : terminal,
      )
    } catch (error) {
      settle(
        failed(
          'terminal',
          `native-action-conservation-failed:${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      throw error
    }
  }
  const callbacks: NativeBatchCallbacks = {
    onComplete: async (result, canContinue) => {
      if (!canContinue()) return
      await conserve(
        result,
        result.children.some((child) => child.contextBlock !== undefined)
          ? failed('terminal', 'native-action-incomplete:action-context-missing')
          : { ok: true, value: { native: result, contributionIds: [], records: [] } },
      )
    },
    onStop: async (reason, result) => {
      if (result === null) settle(failed('terminal', `native-action-stopped:${reason}`))
      else await conserve(result, failed('terminal', `native-action-incomplete:${reason}`))
    },
  }
  const stopAndAwait = async (reason: string, fallback: CorrectionEffectResult<NativeDispatchResult>) => {
    try {
      await options.native.stopOwned(batch, reason)
    } catch (error) {
      settle(
        failed(
          'terminal',
          ...(fallback.ok ? [] : fallback.diagnostics),
          `native-action-stop-failed:${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
    if (!settled) settle(fallback)
    return await deferred.promise
  }
  const stopOnAbort = (): void => {
    announcementAborted.resolve()
    settle(failed('terminal', 'fix-run-aborted'))
    void options.native.stopOwned(batch, 'fix-run-aborted').catch(() => undefined)
  }
  options.signal.addEventListener('abort', stopOnAbort, { once: true })
  try {
    const beforeActivation = abortFence<NativeDispatchResult>()
    if (beforeActivation) return beforeActivation
    options.native.activate(batch, callbacks)
    const beforeAnnouncement = abortFence<NativeDispatchResult>()
    if (beforeAnnouncement) return await stopAndAwait('fix-run-aborted', beforeAnnouncement)
    const announced = await Promise.race([
      options.native.announce(batch).then(() => true),
      announcementAborted.promise.then(() => false),
    ])
    if (!announced) return await deferred.promise
    const started = await options.onStarted(batch, binding)
    if (!started.ok)
      return await stopAndAwait('correction-action-start-unrecorded', failed('terminal', ...started.diagnostics))
    return await deferred.promise
  } catch (error) {
    return await stopAndAwait(
      'native-action-dispatch-failed',
      failed('terminal', `native-action-dispatch-failed:${error instanceof Error ? error.message : String(error)}`),
    )
  } finally {
    options.signal.removeEventListener('abort', stopOnAbort)
  }
}
