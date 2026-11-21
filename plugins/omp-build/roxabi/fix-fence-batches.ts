import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'

const owners = new WeakMap<NativeBatch, FixExecutionFence>()

export function bindFixBatch(batch: NativeBatch, fence: FixExecutionFence): boolean {
  if (owners.has(batch)) return false
  owners.set(batch, fence)
  return true
}

export function belongsToFixFence(batch: NativeBatch, fence: FixExecutionFence): boolean {
  return owners.get(batch) === fence
}

/** Non-Fix batches continue through their own existing admission policy. */
export function admitFixBatch(batch: NativeBatch, admitNative: () => boolean): boolean {
  const owner = owners.get(batch)
  return owner === undefined ? admitNative() : owner.admit(batch, admitNative)
}
