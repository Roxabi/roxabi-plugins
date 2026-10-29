import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { NativeBatch } from './contracts'
import type { NativeBatchController } from './controller'
import { indexAdmittedChildBatch } from './executed-child-lifecycle.ts'
import type { ActiveBatch } from './state'

export function admitNativeBatch(
  controller: NativeBatchController,
  active: ActiveBatch | null,
  owned: Map<string, ActiveBatch>,
  batch: NativeBatch,
  toolCallId: string,
  ctx: ExtensionContext,
  current: () => boolean,
): boolean {
  if (
    !active ||
    active.settling ||
    active.batch !== batch ||
    !active.announced ||
    !active.announcementDispatched ||
    active.admittedToolCallId !== null ||
    ctx.agent.kind !== 'main' ||
    ctx.agent.depth !== 0 ||
    !current()
  )
    return false
  indexAdmittedChildBatch(controller, active, ctx, current)
  active.admittedToolCallId = toolCallId
  active.executionAbort = new AbortController()
  const { promise, resolve } = Promise.withResolvers<void>()
  active.executionDone = promise
  active.finishExecution = resolve
  owned.set(toolCallId, active)
  return true
}
