import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { continueAtDestination } from './feature-framing-controller-destination.ts'
import {
  blockLease,
  type ControllerCore,
  currentAt,
  type LeaseState,
  live,
  maybeFinalize,
  sameLocation,
  sameSession,
  terminal,
} from './feature-framing-controller-lease.ts'
import { settleOutcome } from './feature-framing-controller-outcome.ts'
import { readIssueSource } from './feature-framing-controller-proposal.ts'
import { createFramingEffectGuard } from './feature-framing-effect-guard.ts'
import { verifyFramingProcedures } from './feature-framing-procedures.ts'
import type { UwOperations } from './uw-contract.ts'
import type { FramingOperationResult, PreparedFramingProposal } from './uw-framing-contract.ts'
import { reservePreparedFramingProposal } from './uw-framing-prepare.ts'

type Procedures = NonNullable<LeaseState['procedures']>

/** Fresh supply and, for an issue source, the exact captured basis; any change blocks. */
async function sourcesStillFresh(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  procedures: Procedures,
  claimedNow: () => boolean,
): Promise<boolean> {
  const supply = await verifyFramingProcedures(procedures)
  if (!claimedNow()) return false
  if (!supply.ok) {
    blockLease(core, lease, 'framing-supply-changed')
    return false
  }
  if (lease.source.kind !== 'issue') return true
  const fresh = await readIssueSource(core, lease, ctx)
  if (!claimedNow()) return false
  if ('problem' in fresh || fresh.basis !== lease.sourceBasis) {
    blockLease(core, lease, 'framing-source-changed')
    return false
  }
  return true
}

/** Exactly one `uw.frame` under the revocable effect guard; the fresh operator never outlives it. */
async function frameOnce(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  prepared: PreparedFramingProposal,
  procedures: Procedures,
  claimedNow: () => boolean,
): Promise<{ outcome: FramingOperationResult; uw: UwOperations } | null> {
  const operator = core.host.operator(ctx)
  let uw: UwOperations
  try {
    uw = await core.host.uw({ ctx, operator })
  } catch (error) {
    operator.cancel()
    throw error
  }
  if (!claimedNow()) {
    operator.cancel()
    return null
  }
  const effects = createFramingEffectGuard({
    ctx,
    procedures,
    operationId: prepared.proposal.operationId,
    proposalDigest: prepared.digest,
    isCurrent: claimedNow,
  })
  lease.revokeEffects = () => {
    effects.revoke()
    operator.cancel()
  }
  try {
    const outcome = await uw.frame(prepared, {
      async check(point) {
        await effects.guard.check(point)
        if (point.at === 'before-effect' && lease.phase.kind === 'confirming') lease.phase = { kind: 'committing' }
      },
    })
    return { outcome, uw }
  } finally {
    lease.revokeEffects = null
    effects.revoke()
    operator.cancel()
  }
}

/** The one human confirmation and effect surface for a staged proposal. */
export async function confirmAndFrame(core: ControllerCore, lease: LeaseState, ctx: ExtensionContext): Promise<void> {
  const claimed = lease.proposal
  const procedures = lease.procedures
  if (
    lease.phase.kind !== 'proposal-ready' ||
    claimed === null ||
    claimed.revision !== lease.revision ||
    procedures === null
  ) {
    core.host.status('feature-framing: no current proposal to confirm')
    return
  }
  if (!sameLocation(lease.origin, ctx)) {
    blockLease(core, lease, 'framing-location-changed')
    return
  }
  const revision = lease.revision
  lease.proposal = null
  lease.phase = { kind: 'confirming' }
  const claimedNow = (): boolean =>
    currentAt(core, lease, ctx) &&
    lease.revision === revision &&
    (lease.phase.kind === 'confirming' || lease.phase.kind === 'committing')
  let fresh: boolean
  try {
    fresh = await sourcesStillFresh(core, lease, ctx, procedures, claimedNow)
  } catch (error) {
    reservePreparedFramingProposal(claimed.prepared)?.(false)
    throw error
  }
  if (!fresh) {
    reservePreparedFramingProposal(claimed.prepared)?.(false)
    return
  }
  let framed: { outcome: FramingOperationResult; uw: UwOperations } | null
  try {
    framed = await frameOnce(core, lease, ctx, claimed.prepared, procedures, claimedNow)
  } catch (error) {
    reservePreparedFramingProposal(claimed.prepared)?.(false)
    throw error
  }
  if (framed === null) reservePreparedFramingProposal(claimed.prepared)?.(false)
  if (framed?.outcome.status === 'deferred') {
    if (claimedNow()) {
      lease.proposal = claimed
      lease.phase = { kind: 'proposal-ready', digest: claimed.prepared.digest }
      core.host.status('feature-framing: proposal deferred; use Ctrl+Alt+U to reopen')
    } else {
      reservePreparedFramingProposal(claimed.prepared)?.(false)
      if (live(core, lease)) blockLease(core, lease, 'framing-location-changed')
    }
    return
  }
  if (framed !== null)
    await settleOutcome(core, lease, ctx, claimed.prepared, { outcome: framed.outcome, uw: framed.uw })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
export async function actOnFraming(core: ControllerCore, ctx: ExtensionContext): Promise<void> {
  const host = core.host
  async function act(ctx: ExtensionContext): Promise<void> {
    const lease = core.current
    if (lease === null || !live(core, lease) || terminal(lease.phase)) {
      host.status('feature-framing: nothing awaits confirmation')
      return
    }
    if (lease.acting) {
      host.status('feature-framing: a confirmation is already in progress')
      return
    }
    if (
      !sameSession(lease.origin, ctx) ||
      !ctx.hasUI ||
      ctx.mode !== 'tui' ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages()
    ) {
      host.status(
        'feature-framing: the shortcut needs the idle root TUI session that began framing, with nothing queued',
      )
      return
    }
    lease.acting = true
    lease.inflight += 1
    try {
      if (lease.phase.kind === 'proposal-ready') await confirmAndFrame(core, lease, ctx)
      else if (lease.phase.kind === 'awaiting-human-move') await continueAtDestination(core, lease, ctx, true)
      else host.status(`feature-framing: nothing to confirm while ${lease.phase.kind}`)
    } catch (error) {
      blockLease(
        core,
        lease,
        'framing-act-failed',
        undefined,
        `feature-framing blocked: ${errorText(error)}. Effects, including an already-started checkout git step, may be incomplete; nothing is rolled back, retried, delivered or moved.`,
      )
    } finally {
      lease.acting = false
      lease.inflight -= 1
      maybeFinalize(core, lease)
    }
  }
  return act(ctx)
}
