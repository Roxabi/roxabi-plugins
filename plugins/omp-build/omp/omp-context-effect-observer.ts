import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { createContextLocalFileObserver } from '../roxabi/context-local-file-observer.ts'
import { captureOrigin, sameLocation, sameSession } from '../roxabi/feature-framing-controller-lease.ts'

/** Host-only closure; no command argument can supply its origin or observation namespace. */
export function ownedContextEffectObserverFactory(ctx: ExtensionContext, current: () => boolean) {
  const origin = captureOrigin(ctx)
  return () =>
    createContextLocalFileObserver(
      {
        kind: 'confirmation-local-observer',
        id: randomUUID(),
        sessionId: origin.sessionId,
        agentId: origin.agentId,
      },
      () => current() && sameSession(origin, ctx) && sameLocation(origin, ctx),
    )
}
