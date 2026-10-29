import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { NativeBatch, NativeExecutionObservation, NativeExtension } from './contracts'
import type { NativeBatchController } from './controller'
import { captureNativeRoot, executeNativeBatch } from './native-sdk-adapter.ts'
import { taskMaskCurrent } from './task-mask-lease'

function selectedBatch(controller: NativeBatchController, ctx: ExtensionContext, params: unknown): NativeBatch {
  const batch = controller.active()
  const wire = batch && controller.wire(batch)
  if (
    !batch ||
    !wire ||
    ctx.agent.kind !== 'main' ||
    ctx.agent.depth !== 0 ||
    typeof params !== 'object' ||
    params === null ||
    Array.isArray(params) ||
    Object.keys(params).length !== 1 ||
    !Object.hasOwn(params, 'batchId') ||
    !('batchId' in params) ||
    typeof params.batchId !== 'string' ||
    params.batchId !== wire.batchId
  )
    throw new Error('native batch selector is not the active authorized action')
  return batch
}

async function observeExecution(
  pi: NativeExtension,
  controller: NativeBatchController,
  batch: NativeBatch,
  toolCallId: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  current: () => boolean,
): Promise<NativeExecutionObservation> {
  const observation: NativeExecutionObservation = { toolCallId, results: [], errors: [] }
  try {
    const ownedSignal = controller.executionSignal(batch)
    if (!ownedSignal) throw new Error('native cancellation ownership unavailable')
    const result = await executeNativeBatch({
      ctx,
      pi,
      batch,
      toolCallId,
      signal: signal ? AbortSignal.any([signal, ownedSignal]) : ownedSignal,
      current: () => controller.current(batch) && current(),
      bindChild: controller.bindChild.bind(controller),
    })
    observation.results = result.results
    observation.errors = result.errors
  } catch (error) {
    observation.errors.push(error instanceof Error ? error.message : String(error))
  }
  if (!current()) observation.errors.push('native root generation changed')
  try {
    if (!(await taskMaskCurrent(controller, batch)))
      observation.errors.push('native task mask drifted during execution')
  } catch (error) {
    observation.errors.push(
      `native task mask verification failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return observation
}

export async function executeOwnedBatch(
  pi: NativeExtension,
  controller: NativeBatchController,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
) {
  controller.observeRootContext(ctx)
  const batch = selectedBatch(controller, ctx, params)
  if (!(await taskMaskCurrent(controller, batch))) {
    await controller.stopOwned(batch, 'native-task-mask-drifted')
    throw new Error('native task mask is unavailable or drifted')
  }
  const rootOwner = await captureNativeRoot(ctx)
  if (!rootOwner || !controller.admit(batch, toolCallId, ctx, rootOwner.current)) {
    await controller.stopOwned(batch, 'native-root-or-action-unavailable')
    throw new Error('native root or action unavailable')
  }
  try {
    try {
      const observation = await observeExecution(pi, controller, batch, toolCallId, ctx, signal, rootOwner.current)
      const compact = controller.prepareOwnedResult(observation, ctx)
      controller.queueOwnedSettlement(observation)
      return compact
    } finally {
      controller.finishExecution(batch)
    }
  } catch (error) {
    await controller.stopOwned(batch, 'native-result-publication-failed')
    throw error
  }
}
