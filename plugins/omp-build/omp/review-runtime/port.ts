import type { NativeBatch, NativeExtension, NativeTaskWireInput } from './contracts'
import type { NativeBatchController } from './controller'
import { acquireTaskMask, releaseTaskMask, taskMaskCurrent } from './task-mask-lease'

const endedTurns = new WeakSet<NativeBatchController>()

export function resetNativeTurn(controller: NativeBatchController): void {
  endedTurns.delete(controller)
}

export function markNativeTurnEnded(controller: NativeBatchController): void {
  endedTurns.add(controller)
}

export type HiddenControlMessage = {
  customType: 'omp-build-native-batch'
  display: false
  content: string
}

export function hiddenControlMessage(input: NativeTaskWireInput): HiddenControlMessage {
  const modelFacing = input
  return {
    customType: 'omp-build-native-batch',
    display: false,
    content: [
      'OMP_BUILD_NATIVE_BATCH:',
      JSON.stringify(modelFacing),
      'Invoke omp_build_execute_native_batch with exactly this batchId. The host retains the prepared tasks; do not supply task, role, model, or schema.',
      'This control is not model-hidden: display is false and triggerTurn is true, so it enters model context without a visible main-conversation turn.',
    ].join('\n'),
  }
}

/** Port injected into Roxabi products; announce schedules the owned-tool invocation. */
export function createNativeReviewPort(
  pi: NativeExtension,
  controller: NativeBatchController,
): Pick<NativeBatchController, 'activate' | 'inactive' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
} {
  return {
    activate: controller.activate.bind(controller),
    inactive: controller.inactive.bind(controller),
    stopOwned: controller.stopOwned.bind(controller),
    async announce(batch): Promise<void> {
      if (!controller.announce(batch)) {
        throw new Error('native batch is not the active batch ready for announcement')
      }
      const immediate = controller.takeIdleAnnouncement(batch)
      const late =
        immediate === null && endedTurns.has(controller) && controller.active() === batch
          ? controller.consumeFollowUp()
          : null
      const selected = immediate ?? late
      const input = selected === null ? null : controller.wire(selected)
      if (selected !== null && input !== null) {
        await sendNativeAnnouncement(pi, controller, selected, hiddenControlMessage(input), late !== null)
      }
    },
  }
}

/** Acquire before sending; never hold the SDK mutation queue across the send. */
export async function sendNativeAnnouncement(
  pi: NativeExtension,
  controller: NativeBatchController,
  batch: NativeBatch,
  message: HiddenControlMessage,
  nextTurn = false,
): Promise<void> {
  try {
    await acquireTaskMask(controller, batch)
    if (controller.active() !== batch || !(await taskMaskCurrent(controller, batch)))
      throw new Error('native batch or task mask changed before announcement')
    await pi.sendMessage(message, nextTurn ? { triggerTurn: true, deliverAs: 'nextTurn' } : { triggerTurn: true })
  } catch (error) {
    try {
      await releaseTaskMask(controller, false, batch)
    } catch (restoreError) {
      controller.status(
        `native task mask restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
      )
    }
    const reason = `native announcement failed: ${error instanceof Error ? error.message : String(error)}`
    controller.status(reason)
    await controller.stopOwned(batch, reason)
    throw error
  }
}

/** Consume and serialize the one valid agent-end follow-up, if any. */
export async function followUpAnnouncement(pi: NativeExtension, controller: NativeBatchController): Promise<void> {
  const batch = controller.consumeFollowUp()
  const input = batch === null ? null : controller.wire(batch)
  if (batch !== null && input !== null) await sendNativeAnnouncement(pi, controller, batch, hiddenControlMessage(input))
}
