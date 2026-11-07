import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { localProtocolRoot } from '../omp/action-communication.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { FramingOperator, PendingFramingHandoff } from './feature-framing-contract.ts'
import { sha256Text } from './feature-framing-controller-index.ts'
import {
  blockLease,
  type ControllerCore,
  closeLease,
  type DetailRef,
  type LeaseState,
  live,
  sameSession,
} from './feature-framing-controller-lease.ts'
import { verifyFramedFeatureDestination } from './feature-framing-handoff.ts'
import { loadFramingProcedures } from './feature-framing-procedures.ts'
export const NOTHING_FOLLOWS = 'Nothing is retried, delivered, checked out or moved.'

/** Fresh destination bytes for every retained detail: the moved session must still hold them exactly. */
function detailsIntact(ctx: ExtensionContext, details: readonly DetailRef[]): boolean {
  const root = localProtocolRoot(ctx)
  if (root === null) return false
  return details.every((detail) => {
    try {
      return sha256Text(readFileSync(join(root, detail.reference.slice('local://'.length)), 'utf8')) === detail.digest
    } catch {
      return false
    }
  })
}
/** Still the same idle root session at the exact destination, in the destination-check phase. */
function atDestination(core: ControllerCore, lease: LeaseState, ctx: ExtensionContext, destination: string): boolean {
  return (
    live(core, lease) &&
    lease.phase.kind === 'destination-check' &&
    sameSession(lease.origin, ctx) &&
    ctx.cwd === destination &&
    ctx.sessionManager.getCwd() === destination &&
    ctx.isIdle() &&
    !ctx.hasPendingMessages()
  )
}

function waitAgain(core: ControllerCore, lease: LeaseState, message: string): void {
  if (!live(core, lease)) return
  if (lease.phase.kind === 'destination-check') lease.phase = { kind: 'awaiting-human-move' }
  core.host.status(message)
}

/** The ticket is pending, the session sits at its destination, and the human attests the completed move. */
async function attestedMove(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  attest: boolean,
): Promise<PendingFramingHandoff | null> {
  const ticket = lease.ticket
  if (ticket === null || lease.ticketConsumed || lease.phase.kind !== 'awaiting-human-move') {
    core.host.status('feature-framing: no pending handoff')
    return null
  }
  const destination = ticket.preparation.destination
  if (ctx.cwd !== destination || ctx.sessionManager.getCwd() !== destination) {
    core.host.status(
      `feature-framing: still waiting. Run native /move ${destination}, then press the framing shortcut.`,
    )
    return null
  }
  lease.phase = { kind: 'destination-check' }
  let observed = !attest
  if (attest) {
    try {
      observed = await ctx.ui.confirm(
        'Confirm the completed /move',
        `Confirm only what you saw: native /move ${destination} displayed exactly "Moved to ${destination}", and no move or session change is still in progress.`,
      )
    } catch {
      observed = false
    }
  }
  if (!observed) {
    waitAgain(core, lease, `feature-framing: move not attested; still waiting for /move ${destination}`)
    return null
  }
  if (!atDestination(core, lease, ctx, destination)) {
    waitAgain(core, lease, 'feature-framing: the session changed during attestation; still waiting')
    return null
  }
  return ticket
}

/** The same procedure supply and byte-identical retained details must survive the move. */
async function destinationIntact(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  ticket: PendingFramingHandoff,
): Promise<boolean> {
  const destination = ticket.preparation.destination
  const procedures = await loadFramingProcedures(core.host.procedurePorts({ cwd: destination }))
  if (!atDestination(core, lease, ctx, destination)) {
    waitAgain(core, lease, 'feature-framing: the session changed during destination checks; still waiting')
    return false
  }
  if (!procedures.ok || procedures.value.manifest.digest !== ticket.procedures.digest) {
    blockLease(
      core,
      lease,
      'framing-supply-changed',
      undefined,
      `feature-framing blocked: the framing procedure supply changed across the move. ${NOTHING_FOLLOWS}`,
    )
    return false
  }
  if (!detailsIntact(ctx, ticket.detailRefs)) {
    blockLease(
      core,
      lease,
      'framing-detail-changed',
      undefined,
      `feature-framing blocked: retained framing detail is missing or changed at the destination. ${NOTHING_FOLLOWS}`,
    )
    return false
  }
  return true
}

/** Fresh UW and destination verification; the operator is cancelled on every non-continuing path. */
async function verifiedContinuation(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  ticket: PendingFramingHandoff,
  operator: FramingOperator,
): Promise<ContinueFeatureInput | null> {
  let verified: { continuation: ContinueFeatureInput } | ContinueFeatureResult
  try {
    const uw = await core.host.uw({ ctx, operator })
    const read = await uw.readUw(ticket.preparation.root)
    verified = await verifyFramedFeatureDestination({
      ticket: ticket.preparation,
      read,
      cwd: ctx.cwd,
      git: core.host.git,
      gh: core.host.gh,
      uw,
      ...(core.host.pluginPin === undefined ? {} : { pluginPin: core.host.pluginPin }),
    })
  } catch (error) {
    operator.cancel()
    throw error
  }
  if (!atDestination(core, lease, ctx, ticket.preparation.destination)) {
    operator.cancel()
    waitAgain(core, lease, 'feature-framing: the session changed during destination checks; still waiting')
    return null
  }
  if ('kind' in verified) {
    operator.cancel()
    const reason = verified.kind === 'blocked' ? verified.reason : verified.kind
    blockLease(
      core,
      lease,
      reason.startsWith('framing-') ? reason : `framing-destination-${reason}`,
      undefined,
      `feature-framing blocked: destination refused (${reason}). ${NOTHING_FOLLOWS}`,
    )
    return null
  }
  return verified.continuation
}
/**
 * Same-session destination step: genuine human attestation of a completed native `/move`, then fresh
 * supply, detail, UW and destination checks before exactly one ordinary continuation.
 */
export async function continueAtDestination(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  attest: boolean,
): Promise<void> {
  const ticket = await attestedMove(core, lease, ctx, attest)
  if (ticket === null || !(await destinationIntact(core, lease, ctx, ticket))) return
  const operator = core.host.operator(ctx)
  const continuation = await verifiedContinuation(core, lease, ctx, ticket, operator)
  if (continuation === null) return
  lease.ticketConsumed = true
  lease.phase = { kind: 'continuing' }
  try {
    await core.host.continueFeature({ ctx, continuation, operator })
  } catch (error) {
    operator.cancel()
    closeLease(
      core,
      lease,
      { kind: 'blocked', reason: 'framing-continuation-failed' },
      undefined,
      `feature-framing blocked: the ordinary continuation failed (${error instanceof Error ? error.message : String(error)}). ${NOTHING_FOLLOWS}`,
    )
    return
  }
  closeLease(
    core,
    lease,
    { kind: 'closed', reason: 'continued' },
    undefined,
    `feature-framing: continued ${ticket.preparation.root.target} at ${ticket.preparation.destination}`,
  )
}
