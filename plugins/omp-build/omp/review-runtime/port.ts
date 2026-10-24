import type { NativeBatch, NativeExtension, NativeTaskWireInput } from './contracts'
import { NATIVE_TASK_INTENT } from './contracts'
import type { NativeBatchController } from './controller'

function announceMessage(input: NativeTaskWireInput): string {
  // Model-facing wire only: SDK requires harness intent `i`; execution-authority admit keeps `input` without it.
  const modelFacing = { i: NATIVE_TASK_INTENT, ...input }
  return [
    'OMP_BUILD_NATIVE_BATCH:',
    JSON.stringify(modelFacing),
    'Invoke exactly this one prepared native task batch now. Do not alter its context, tasks, roles, names, or schema fields. If it cannot be invoked exactly, stop and report the divergence.',
  ].join('\n')
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
      const input = immediate === null ? null : controller.wire(immediate)
      if (input !== null) await pi.sendUserMessage(announceMessage(input))
    },
  }
}

/** Consume and serialize the one valid agent-end follow-up, if any. */
export function followUpAnnouncement(controller: NativeBatchController): string | null {
  const batch = controller.consumeFollowUp()
  const input = batch === null ? null : controller.wire(batch)
  return input === null ? null : announceMessage(input)
}
