import type { NativeBatch, NativeExtension, NativeTaskWireInput } from './contracts'
import { NATIVE_TASK_INTENT } from './contracts'
import type { NativeBatchController } from './controller'

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
  const modelFacing = { i: NATIVE_TASK_INTENT, ...input }
  return {
    customType: 'omp-build-native-batch',
    display: false,
    content: [
      'OMP_BUILD_NATIVE_BATCH:',
      JSON.stringify(modelFacing),
      'Invoke exactly this one prepared native task batch now. Do not alter its context, tasks, roles, names, or schema fields. If it cannot be invoked exactly, stop and report the divergence.',
      'This control is not model-hidden: display is false and triggerTurn is true, so it enters model context without a visible main-conversation turn.',
    ].join('\n'),
  }
}

/** Port injected into Roxabi products; dispatch remains a model continuation, never direct task execution. */
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
      const input = controller.wire(immediate ?? late ?? batch)
      if (input !== null && (immediate !== null || late !== null)) {
        await pi.sendMessage(
          hiddenControlMessage(input),
          late === null ? { triggerTurn: true } : { triggerTurn: true, deliverAs: 'nextTurn' },
        )
      }
    },
  }
}

/** Consume and serialize the one valid agent-end follow-up, if any. */
export function followUpAnnouncement(controller: NativeBatchController): HiddenControlMessage | null {
  const batch = controller.consumeFollowUp()
  const input = batch === null ? null : controller.wire(batch)
  return input === null ? null : hiddenControlMessage(input)
}
