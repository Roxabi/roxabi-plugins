import { randomUUID } from 'node:crypto'
import type { ExtensionContext, SessionStopEvent } from '@oh-my-pi/pi-coding-agent'
import type { FramingController, FramingOperator, FramingOwnerClaim } from '../roxabi/feature-framing-contract.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { rootContext } from './omp-feature-session.ts'
import { cancelOperatorConfirmations } from './omp-operator-confirmation.ts'

/** Root session and agent captured synchronously when a `/feature` operation began. */
export type FeatureOperationOrigin = Readonly<{ sessionId: string; agentId: string }>

/**
 * `ordinary`: a confirmation-capable UW operation. `intake`: a `/feature` command whose source is not
 * classified yet; it stays read-only until classified. `framing`: the framing controller's lease.
 */
type Occupant =
  | Readonly<{
      kind: 'ordinary'
      generation: number
      operator: FramingOperator
      origin: FeatureOperationOrigin | null
    }>
  | Readonly<{ kind: 'intake'; generation: number; operator: FramingOperator; origin: FeatureOperationOrigin }>
  | Readonly<{ kind: 'framing'; generation: number; controller: FramingController; revoke: (reason: string) => void }>

type OperationSlot = { readonly extensionInstanceId: string; generation: number; occupant: Occupant | null }

const operationSlots = new WeakMap<object, OperationSlot>()
const installedLifecycles = new WeakSet<object>()

function slotFor(pi: OmpBuildExtensionApi): OperationSlot {
  let slot = operationSlots.get(pi)
  if (slot === undefined) {
    slot = { extensionInstanceId: randomUUID(), generation: 0, occupant: null }
    operationSlots.set(pi, slot)
  }
  return slot
}

function originOf(ctx: ExtensionContext): FeatureOperationOrigin {
  return Object.freeze({ sessionId: ctx.sessionManager.getSessionId(), agentId: ctx.agent.id })
}

/**
 * The ONE owner slot per extension instance. The next occupant is installed before its predecessor is
 * told, so a predecessor's own settlement can never clear its successor.
 */
function occupy(pi: OmpBuildExtensionApi, next: (generation: number) => Occupant): Occupant {
  const slot = slotFor(pi)
  const previous = slot.occupant
  slot.generation += 1
  const occupant = next(slot.generation)
  slot.occupant = occupant
  if (previous === null) return occupant
  if (previous.kind === 'framing') previous.revoke('framing-replaced')
  else previous.operator.cancel()
  return occupant
}

function exactOperation(pi: OmpBuildExtensionApi, operator: FramingOperator) {
  const occupant = operationSlots.get(pi)?.occupant
  return occupant !== undefined && occupant !== null && occupant.kind !== 'framing' && occupant.operator === operator
    ? occupant
    : null
}

/** Clears the exact occupant (same generation) and invalidates it; a newer occupant is untouched. */
function invalidateExact(pi: OmpBuildExtensionApi, generation: number, reason: string): void {
  const slot = operationSlots.get(pi)
  const occupant = slot?.occupant
  if (slot === undefined || occupant === undefined || occupant === null || occupant.generation !== generation) return
  if (occupant.kind === 'framing') {
    // The lease keeps denying until settled; the controller releases the slot itself.
    occupant.controller.cancel(reason)
    return
  }
  slot.occupant = null
  occupant.operator.cancel()
}

/**
 * One interactive root UW operation owns one confirmation capability. A replacement, an aborted
 * root session, or a terminal session transition invalidates the old capability.
 */
export function beginFeatureUwOperation<T extends FramingOperator>(pi: OmpBuildExtensionApi, operator: T): T {
  occupy(pi, (generation) => ({ kind: 'ordinary', generation, operator, origin: null }))
  return operator
}

/** Synchronous `/feature` intake: read-only from before the first await until classified. */
export function beginFeatureUwIntake<T extends FramingOperator>(
  pi: OmpBuildExtensionApi,
  operator: T,
  ctx: ExtensionContext,
): T {
  const origin = originOf(ctx)
  occupy(pi, (generation) => ({ kind: 'intake', generation, operator, origin }))
  return operator
}

/** Root's ordinary post-framing continuation; it explicitly replaces the framing lease. */
export function beginFeatureUwContinuation<T extends FramingOperator>(
  pi: OmpBuildExtensionApi,
  operator: T,
  ctx: ExtensionContext,
): T {
  const origin = originOf(ctx)
  occupy(pi, (generation) => ({ kind: 'ordinary', generation, operator, origin }))
  return operator
}

/** A classified non-framing result: the exact intake becomes the same ordinary operation. */
export function settleFeatureUwIntake(pi: OmpBuildExtensionApi, operator: FramingOperator): void {
  const slot = operationSlots.get(pi)
  const occupant = slot?.occupant
  if (slot === undefined || occupant?.kind !== 'intake' || occupant.operator !== operator) return
  slot.occupant = { kind: 'ordinary', generation: occupant.generation, operator, origin: occupant.origin }
}

export function ownsFeatureUwOperation(pi: OmpBuildExtensionApi, operator: FramingOperator): boolean {
  return exactOperation(pi, operator) !== null
}

/** The captured origin of the exact current operation, or null when it is stale or has none. */
export function featureUwOperationOrigin(
  pi: OmpBuildExtensionApi,
  operator: FramingOperator,
): FeatureOperationOrigin | null {
  return exactOperation(pi, operator)?.origin ?? null
}

export function cancelFeatureUwOperation(pi: OmpBuildExtensionApi, operator: FramingOperator): void {
  const occupant = exactOperation(pi, operator)
  if (occupant !== null) invalidateExact(pi, occupant.generation, 'operation-cancelled')
}

/** Stable identity of this extension instance's owner slot. */
export function featureOperationInstanceId(pi: OmpBuildExtensionApi): string {
  return slotFor(pi).extensionInstanceId
}

/** Replaces the occupant with the framing lease; `revoke` runs only on explicit replacement. */
export function claimFeatureFramingOwner(
  pi: OmpBuildExtensionApi,
  controller: FramingController,
  revoke: (reason: string) => void,
): FramingOwnerClaim {
  const { generation } = occupy(pi, (next) => ({ kind: 'framing', generation: next, controller, revoke }))
  const current = (): boolean => {
    const occupant = operationSlots.get(pi)?.occupant
    return occupant?.kind === 'framing' && occupant.generation === generation
  }
  return Object.freeze({
    generation,
    isCurrent: current,
    release() {
      const slot = operationSlots.get(pi)
      if (slot !== undefined && current()) slot.occupant = null
    },
  })
}

/** The controller holding the slot, including a revoked lease that still denies until settled. */
export function currentFeatureFraming(pi: OmpBuildExtensionApi): FramingController | null {
  const occupant = operationSlots.get(pi)?.occupant
  return occupant?.kind === 'framing' ? occupant.controller : null
}

/** The root extension instance admits only read-only tools during intake/framing, including no new task spawns.
 * Subagents and background jobs started earlier are not gated by this instance.
 */
export function featureOperationReadOnly(pi: OmpBuildExtensionApi): boolean {
  const kind = operationSlots.get(pi)?.occupant?.kind
  return kind === 'intake' || kind === 'framing'
}

function currentOccupant(pi: OmpBuildExtensionApi): Occupant | null {
  return operationSlots.get(pi)?.occupant ?? null
}

/** Completes a revoked framing lease's settlement; a live lease is untouched. */
function settleRevokedFraming(pi: OmpBuildExtensionApi, reason: string): boolean {
  const occupant = currentOccupant(pi)
  if (occupant?.kind !== 'framing') return false
  const view = occupant.controller.view()
  if (view === null || !view.revoked) return false
  invalidateExact(pi, occupant.generation, reason)
  return true
}

export function installFeatureUwOperationLifecycle(pi: OmpBuildExtensionApi): void {
  if (installedLifecycles.has(pi)) return
  installedLifecycles.add(pi)
  const invalidate =
    (reason: string) =>
    (_event: unknown, ctx: ExtensionContext): void => {
      if (!rootContext(ctx)) return
      const occupant = currentOccupant(pi)
      if (occupant !== null) invalidateExact(pi, occupant.generation, reason)
      cancelOperatorConfirmations(ctx, reason)
    }
  pi.on('session_stop', (event: SessionStopEvent, ctx: ExtensionContext) => {
    if (!rootContext(ctx)) return
    const occupant = currentOccupant(pi)
    if (event.signal.aborted) {
      if (occupant !== null) invalidateExact(pi, occupant.generation, 'session-stop-aborted')
      cancelOperatorConfirmations(ctx, 'session-stop-aborted')
      return
    }
    if (occupant === null) return
    if (settleRevokedFraming(pi, 'session-stop-settled')) return
    const generation = occupant.generation
    event.signal.addEventListener(
      'abort',
      () => {
        invalidateExact(pi, generation, 'session-stop-aborted')
        cancelOperatorConfirmations(ctx, 'session-stop-aborted')
      },
      { once: true },
    )
  })
  pi.on('agent_end', (_event, ctx: ExtensionContext) => {
    if (rootContext(ctx)) settleRevokedFraming(pi, 'agent-end-settled')
  })
  pi.on('session_switch', (_event, ctx: ExtensionContext) => {
    if (!rootContext(ctx)) return
    const occupant = currentOccupant(pi)
    if (occupant?.kind === 'framing') {
      // Only a written aggregate awaiting the human-observed `/move` survives, in the same session.
      const view = occupant.controller.view()
      if (view !== null && view.pendingMove !== null && ctx.sessionManager.getSessionId() === view.sessionId) return
    }
    if (occupant !== null) invalidateExact(pi, occupant.generation, 'session-switch')
    cancelOperatorConfirmations(ctx, 'session-switch')
  })
  pi.on('session_branch', invalidate('session-branch'))
  pi.on('session_tree', invalidate('session-tree'))
  pi.on('session_shutdown', invalidate('session-shutdown'))
}
