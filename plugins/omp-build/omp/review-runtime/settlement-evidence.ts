import { verifyHostAction } from './action-registry.ts'
import type { NativeBatchCallbacks, NativeChildResult } from './contracts'
import type { ActiveBatch } from './state'

export async function publishRaw(
  callbacks: NativeBatchCallbacks,
  children: readonly NativeChildResult[],
  current: () => boolean = () => true,
): Promise<string[]> {
  const errors: string[] = []
  for (const child of children) {
    if (!current()) {
      errors.push('native-root-generation-changed')
      break
    }
    if (child.canPublishContext && !child.canPublishContext()) break
    try {
      await callbacks.onChildResult?.(child)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors
}

export async function integrityFailure(active: ActiveBatch): Promise<string | null> {
  const codes: string[] = []
  for (const task of active.batch.tasks.tasks) {
    const snapshot = task.action?.snapshot
    if (snapshot === undefined) {
      codes.push('action-handle-missing')
      continue
    }
    const verified = await verifyHostAction(snapshot)
    if (!verified.ok) codes.push(...verified.diagnostics.map((item) => item.code))
  }
  return codes.length === 0 ? null : [...new Set(codes)].join(',')
}

export function blocked(children: readonly NativeChildResult[], reason: string): NativeChildResult[] {
  return children.map((child) => ({ ...child, usable: false, reason }))
}
