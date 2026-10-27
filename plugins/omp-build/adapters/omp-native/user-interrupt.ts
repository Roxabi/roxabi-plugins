import { Flag, is } from '@oh-my-pi/pi-ai/error/flags'

/** Session-boundary Esc/RPC user-abort: SDK stamps Flag.UserInterrupt on errorId. */
export function hasNativeUserInterruptFlag(errorId: number | undefined): boolean {
  return is(errorId, Flag.UserInterrupt)
}
