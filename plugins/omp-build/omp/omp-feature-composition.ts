import type { ExtensionContext, SessionStopEvent } from '@oh-my-pi/pi-coding-agent'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { rootContext } from './omp-feature-session.ts'
import type { CommandOperatorPort } from './omp-operator-confirmation.ts'

const activeOperators = new WeakMap<object, CommandOperatorPort>()
const installedLifecycles = new WeakSet<object>()

/**
 * One /feature operation owns one context-bound confirmation capability. A replacement, an
 * aborted root session, or a terminal session transition invalidates the old capability.
 */
export function beginFeatureUwOperation(pi: OmpBuildExtensionApi, operator: CommandOperatorPort): CommandOperatorPort {
  activeOperators.get(pi)?.cancel()
  activeOperators.set(pi, operator)
  return operator
}

function cancelExactFeatureUwOperation(pi: OmpBuildExtensionApi, operator: CommandOperatorPort): void {
  if (activeOperators.get(pi) !== operator) return
  operator.cancel()
  activeOperators.delete(pi)
}

export function cancelFeatureUwOperation(pi: OmpBuildExtensionApi): void {
  const operator = activeOperators.get(pi)
  if (operator !== undefined) cancelExactFeatureUwOperation(pi, operator)
}

export function installFeatureUwOperationLifecycle(pi: OmpBuildExtensionApi): void {
  if (installedLifecycles.has(pi)) return
  installedLifecycles.add(pi)
  const cancel = (_event: unknown, ctx: ExtensionContext): void => {
    if (rootContext(ctx)) cancelFeatureUwOperation(pi)
  }
  pi.on('session_stop', (event: SessionStopEvent, ctx: ExtensionContext) => {
    if (!rootContext(ctx)) return
    const operator = activeOperators.get(pi)
    if (operator === undefined) return
    if (event.signal.aborted) {
      cancelExactFeatureUwOperation(pi, operator)
      return
    }
    event.signal.addEventListener('abort', () => cancelExactFeatureUwOperation(pi, operator), { once: true })
  })
  pi.on('session_switch', cancel)
  pi.on('session_shutdown', cancel)
}
