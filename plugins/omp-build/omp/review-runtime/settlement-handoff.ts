import type { NativeSuccessor } from './contracts.ts'
import { rootCurrent } from './executed-child-lifecycle.ts'
import type { ActiveBatch } from './state.ts'

/** Retire only the joined predecessor writer; its terminal remains stop-owned until delivery ends. */
export function handoffReceivedSettlement(
  active: ActiveBatch,
  predecessor: Promise<NativeSuccessor | undefined>,
  retiredWriters: WeakSet<ActiveBatch>,
): Promise<void> {
  return predecessor.then((successor) => {
    if (successor === undefined || active.continuationClosed !== null || !rootCurrent(active)) return
    retiredWriters.add(active)
    return successor()
  })
}
