import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeBatchCallbacks, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { NativeBatchController } from '../omp/review-runtime/controller.ts'

type Diagnostic = Record<string, unknown>

/** Observe the real host callbacks without replacing their result, authority, or failure. */
export function observeDriverCallbacks(controller: NativeBatchController): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const activate = controller.activate.bind(controller)
  controller.activate = (batch, callbacks) => {
    const operationId = batch.operationId
    async function observed<T>(event: string, callback: () => T | Promise<T>): Promise<T> {
      try {
        return await callback()
      } catch (error) {
        diagnostics.push({
          event,
          operationId,
          status: 'failed',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
        throw error
      }
    }
    const wrapped: NativeBatchCallbacks = {
      onChildResult: async (child) => {
        await observed('onChildResult', () => callbacks.onChildResult?.(child))
      },
      onComplete: async (result, canContinue) => {
        await observed('onComplete', () => callbacks.onComplete(result, canContinue))
      },
      onStop: async (reason, result) => {
        await observed('onStop', () => callbacks.onStop(reason, result))
      },
      ...(callbacks.onSettled === undefined
        ? {}
        : {
            onSettled: async (result: NativeBatchResult, canContinue: () => boolean) => {
              await observed('onSettled', () => callbacks.onSettled?.(result, canContinue))
            },
          }),
    }
    return activate(batch, wrapped)
  }
  return diagnostics
}

/** Retain only this synthetic fixture's simulator state and actual host callback observations. */
export function retainFixtureDiagnostic(diagnostic: unknown): string {
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('gh-state-missing')
  const simulatorState: unknown = JSON.parse(readFileSync(stateFile, 'utf8'))
  const location = join(mkdtempSync(join(tmpdir(), 'omp-904-native-diagnostic-')), 'fixture.json')
  writeFileSync(location, JSON.stringify({ simulatorState, diagnostic }))
  return location
}

type FixtureDiagnostic = { stage: string; driver: () => unknown }
type Retention = { retained: string | null; captured: unknown; retentionError: unknown }

function captureDiagnostic(diagnostic: FixtureDiagnostic): Retention {
  let captured: unknown
  try {
    captured = { stage: diagnostic.stage, driver: diagnostic.driver() }
    return { retained: retainFixtureDiagnostic(captured), captured, retentionError: undefined }
  } catch (retentionError) {
    return { retained: null, captured, retentionError }
  }
}

export async function finishFixtureDiagnostic(
  controller: NativeBatchController,
  diagnostic: FixtureDiagnostic,
  failed: boolean,
  primary: unknown,
): Promise<void> {
  const { stage } = diagnostic
  let retention: Retention = { retained: null, captured: undefined, retentionError: undefined }
  if (failed || controller.active() !== null) retention = captureDiagnostic(diagnostic)
  const cleanup = await Promise.allSettled([controller.stop('test-cleanup')])
  const errors = cleanup.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length > 0 && retention.retained === null && retention.retentionError === undefined)
    retention = captureDiagnostic(diagnostic)
  const { retained, captured, retentionError } = retention
  if (failed || errors.length > 0 || retentionError !== undefined) {
    const failures = [
      ...(failed ? [primary] : []),
      ...errors,
      ...(retentionError === undefined ? [] : [retentionError]),
    ]
    const details = failures.map((error) =>
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    )
    throw new AggregateError(
      failures,
      `native-fixture-failure: ${JSON.stringify({ stage, retained, details, ...(retained ? {} : { diagnostic: captured }) })}`,
    )
  }
}
