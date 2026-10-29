import { registeredHostAction } from './action-registry.ts'
import type { NativeBatch } from './contracts'

export function validateNativeBatch(batch: NativeBatch): void {
  if (!batch.operationId || batch.tasks.tasks.length === 0) {
    throw new TypeError('native batch requires an operation and tasks')
  }
  const names = batch.tasks.tasks.map((task) => task.name)
  if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
    throw new TypeError('native batch task names must be non-empty and unique')
  }
  for (const task of batch.tasks.tasks) {
    const snapshot = task.action?.snapshot
    if (snapshot === undefined || !registeredHostAction(snapshot)) {
      throw new TypeError('native batch requires a registered action snapshot')
    }
  }
}
