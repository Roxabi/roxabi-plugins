import { scopedStartKey } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'

export type StartDispatch =
  | { readonly kind: 'not-activated' }
  | { readonly kind: 'activated'; readonly operationId: string }
  | { readonly kind: 'closed-before-admission'; readonly operationId: string }
  | { readonly kind: 'conflict' }

const executions = new Map<string, StartDispatch>()

export function startDispatch(start: ScopedRecordRef): StartDispatch | undefined {
  return executions.get(scopedStartKey(start))
}

export function recordStartNotActivated(start: ScopedRecordRef): void {
  const key = scopedStartKey(start)
  if (!executions.has(key)) executions.set(key, { kind: 'not-activated' })
}

export function claimStartActivation(start: ScopedRecordRef, operationId: string): boolean {
  const key = scopedStartKey(start)
  if (executions.has(key)) {
    executions.set(key, { kind: 'conflict' })
    return false
  }
  executions.set(key, { kind: 'activated', operationId })
  return true
}

export function recordStartActivationFailed(start: ScopedRecordRef, operationId: string): void {
  const key = scopedStartKey(start)
  const current = executions.get(key)
  executions.set(
    key,
    current?.kind === 'activated' && current.operationId === operationId
      ? { kind: 'not-activated' }
      : { kind: 'conflict' },
  )
}

export function recordStartClosedBeforeAdmission(start: ScopedRecordRef, operationId: string): void {
  const key = scopedStartKey(start)
  const current = executions.get(key)
  if (current?.kind === 'closed-before-admission' && current.operationId === operationId) return
  executions.set(
    key,
    current?.kind === 'activated' && current.operationId === operationId
      ? { kind: 'closed-before-admission', operationId }
      : { kind: 'conflict' },
  )
}
