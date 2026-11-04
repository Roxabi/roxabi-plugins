export type BatchWaiter = { after: number; resolve: () => void }
export type ContinuationWaiter = { resolve: () => void; reject: (error: Error) => void }

export function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (typeof message === 'object' && message !== null && 'content' in message) return String(message.content)
  return String(message)
}

export function notifyWaiters(
  text: string,
  count: number,
  batches: BatchWaiter[],
  continuations: ContinuationWaiter[],
): void {
  if (text.includes('OMP_BUILD_NATIVE_BATCH')) {
    for (const waiter of continuations.splice(0)) waiter.resolve()
    for (const waiter of batches.splice(0)) if (count > waiter.after) waiter.resolve()
  } else if (text.startsWith('feature-stopped:')) {
    for (const waiter of continuations.splice(0)) waiter.reject(new Error(text))
  }
}
