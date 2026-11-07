import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { PendingFramingHandoff } from './feature-framing-contract.ts'
import { continueAtDestination, NOTHING_FOLLOWS } from './feature-framing-controller-destination.ts'
import { advance, retainDetail } from './feature-framing-controller-index.ts'
import {
  blockLease,
  type ControllerCore,
  closeLease,
  currentAt,
  type DetailRef,
  type LeaseState,
  live,
} from './feature-framing-controller-lease.ts'
import { prepareFramedFeatureHandoff } from './feature-framing-handoff.ts'
import { verifyFramingProcedures } from './feature-framing-procedures.ts'
import type { UwOperations } from './uw-contract.ts'
import type { FramingOperationResult, PreparedFramingProposal } from './uw-framing-contract.ts'

const HANDOFF_STOPPED =
  'A checkout git step that had already started may have completed; nothing is rolled back, retried, continued or moved.'

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function effectsText(outcome: Exclude<FramingOperationResult, { status: 'refused' }>): string {
  const effects = outcome.effects.map(
    (item) =>
      `${item.kind}${item.member === null ? '' : ` ${item.member}`}${item.scope === null ? '' : ` ${item.scope.target}`}: ${item.status}`,
  )
  const holds =
    outcome.status === 'written'
      ? []
      : outcome.holds.map((item) => `${item.code}${item.scope === null ? '' : ` ${item.scope.target}`}`)
  return `Effects: ${effects.length === 0 ? 'none' : effects.join('; ')}.${holds.length === 0 ? '' : ` Holds: ${holds.join('; ')}.`}`
}

/** A failed journal retention never hides the effects; the status still lists them. */
function retainJournal(lease: LeaseState, ctx: ExtensionContext, outcome: FramingOperationResult): DetailRef | null {
  try {
    return retainDetail(lease, ctx, { format: 'omp-build-framing-journal/1', outcome })
  } catch {
    return null
  }
}
async function stageHandoff(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  claimed: PreparedFramingProposal,
  outcome: Extract<FramingOperationResult, { status: 'written' }>,
  uw: UwOperations,
  journal: string,
): Promise<void> {
  const root = outcome.value.root
  /** C's handoff calls this immediately before every git step, including the checkout effect; false means no git. */
  const committing = (): boolean =>
    currentAt(core, lease, ctx) && (lease.phase.kind === 'confirming' || lease.phase.kind === 'committing')
  const checkLive = async (): Promise<boolean> => {
    const procedures = lease.procedures
    if (!committing() || procedures === null) return false
    const supply = await verifyFramingProcedures(procedures)
    return supply.ok && committing() && lease.procedures === procedures
  }
  const read = await uw.readUw(root)
  const preparation = await prepareFramedFeatureHandoff({
    written: outcome.value,
    read,
    cwd: ctx.cwd,
    git: core.host.git,
    checkLive,
    gh: core.host.gh,
    uw,
  })
  if (!live(core, lease)) {
    core.host.status(
      `feature-framing: ${root.target} written, but framing was cancelled during handoff. ${effectsText(outcome)} ${HANDOFF_STOPPED} Detail: ${journal}`,
    )
    return
  }
  if ('kind' in preparation) {
    const reason = preparation.kind === 'blocked' ? preparation.reason : preparation.kind
    const code = reason.startsWith('framing-handoff-') ? reason : `framing-handoff-${reason}`
    blockLease(
      core,
      lease,
      code,
      undefined,
      `feature-framing blocked: ${root.target} written; handoff refused (${reason}). ${effectsText(outcome)} ${HANDOFF_STOPPED} Detail: ${journal}`,
    )
    return
  }
  const procedures = lease.procedures
  if (procedures === null) {
    blockLease(core, lease, 'framing-supply-unavailable')
    return
  }
  const ticket: PendingFramingHandoff = deepFreeze({
    ticketId: randomUUID(),
    invocation: structuredClone(claimed.proposal.invocation),
    proposalDigest: claimed.digest,
    preparation,
    effects: structuredClone(outcome.effects),
    sourceSession: { sessionId: lease.origin.sessionId, agentId: lease.origin.agentId, cwd: lease.origin.cwd },
    detailRefs: [...lease.details],
    procedures: structuredClone(procedures.manifest),
  })
  lease.ticket = ticket
  lease.token = null
  lease.phase = { kind: 'awaiting-human-move' }
  const destination = preparation.destination
  if (
    preparation.checkout.status === 'ready' &&
    ctx.cwd === destination &&
    ctx.sessionManager.getCwd() === destination
  ) {
    await continueAtDestination(core, lease, ctx, false)
    return
  }
  core.host.status(
    `feature-framing: ${root.target} written. Run native /move ${destination}, check that it displays "Moved to ${destination}", then press the framing shortcut. Nothing continues before that.`,
  )
}
/** A Wayfinder is non-UW: report its cards and close; no checkout, Mandate or continuation. */
function closeWayfinder(
  core: ControllerCore,
  lease: LeaseState,
  outcome: Extract<FramingOperationResult, { status: 'written' }>,
  detail: string,
): void {
  const cards = outcome.value.members.map((member) => `${member.key} ${member.scope.target}`).join(', ')
  const report = `Wayfinder ${outcome.value.root.target} framed, pas d’UW: cards ${cards}. ${effectsText(outcome)} No checkout, Mandate or continuation follows. Detail: ${detail}`
  if (!live(core, lease)) {
    core.host.status(`feature-framing: ${report} Framing was cancelled meanwhile; nothing else happens.`)
    return
  }
  closeLease(core, lease, { kind: 'closed', reason: 'wayfinder-framed' }, undefined, `feature-framing: ${report}`)
}

export async function settleOutcome(
  core: ControllerCore,
  lease: LeaseState,
  ctx: ExtensionContext,
  prepared: PreparedFramingProposal,
  framed: { outcome: FramingOperationResult; uw: UwOperations },
): Promise<void> {
  const outcome = framed.outcome
  lease.outcome = outcome
  const detail = retainJournal(lease, ctx, outcome)?.reference ?? 'unretained'
  if (outcome.status === 'refused') {
    if (!live(core, lease)) return
    lease.phase = { kind: 'interview', stage: lease.stage, waitingQuestion: null }
    advance(lease, ctx)
    const codes = outcome.diagnostics.map((item) => item.code).join(', ')
    core.host.status(
      `feature-framing: proposal not applied (${codes || 'declined'}); zero effects, the interview continues`,
    )
    return
  }
  if (outcome.status !== 'written') {
    blockLease(
      core,
      lease,
      'framing-effects-incomplete',
      undefined,
      `feature-framing blocked: framing ${outcome.status}. ${effectsText(outcome)} ${NOTHING_FOLLOWS} Detail: ${detail}`,
    )
    return
  }
  if (outcome.value.kind === 'wayfinder') return closeWayfinder(core, lease, outcome, detail)
  await stageHandoff(core, lease, ctx, prepared, outcome, framed.uw, detail)
}
