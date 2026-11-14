import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { FramingOrigin } from '../roxabi/feature-framing-controller-lease.ts'
import type { OperatorResult, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { showOperatorProposal } from './omp-operator-confirmation-dialog.ts'
import { safeOperatorError } from './omp-operator-confirmation-field.ts'
import type { OperatorChoice } from './omp-operator-confirmation-input.ts'
import {
  createSlot,
  enqueue,
  here,
  hide,
  type Presenter,
  type Slot,
  setPortStatus,
} from './omp-operator-confirmation-presenter.ts'

function refusal(proposal: PreparedOperatorProposal, code: string, message: string): readonly UwDiagnostic[] {
  const target = proposal.proposal
  if (target.format === 'omp-build-uw-framing/1') {
    const source = target.input.source
    const location =
      source.kind === 'issue'
        ? { kind: 'native' as const, uw: source.uw, connection: 'state' as const }
        : { kind: 'repository' as const, repository: source.repository }
    return [{ code, message, location, related: [] }]
  }
  if ('target' in target) {
    if (target.target.kind === 'create')
      return [{ code, message, location: { kind: 'repository', repository: target.target.repository }, related: [] }]
    return [{ code, message, location: { kind: 'native', uw: target.target.uw, connection: 'state' }, related: [] }]
  }
  const uw = 'origin' in target ? target.origin : target.uw
  return [{ code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }]
}

export type EscapeMode = 'hold' | 'defer'
type StopConfirmation = Exclude<OperatorResult<never>, { status: 'confirmed' }>
type ProposalDetail = Parameters<typeof showOperatorProposal>[2]

type ConfirmationDrive<T> = {
  ctx: ExtensionContext
  origin: FramingOrigin
  port: object
  proposal: PreparedOperatorProposal
  action: (evidence: OperatorConfirmationEvidence) => Promise<T>
  presenter: Presenter
  detail: ProposalDetail
  escapeMode: EscapeMode
  displayedDigest: string
  displayedProposal: string
  cancelled: Promise<void>
  signal: AbortSignal
  unavailable: (proposal: PreparedOperatorProposal) => StopConfirmation
  live: () => boolean
  failShow: () => void
  bindSlot: (slot: Slot) => void
  releaseSlot: (slot: Slot) => void
  resolveHeld: () => void
}

export function stillRoot(ctx: ExtensionContext, live: boolean): boolean {
  return live && ctx.agent.kind === 'main' && ctx.agent.depth === 0 && ctx.hasUI && ctx.mode === 'tui'
}

function changedRefusal(proposal: PreparedOperatorProposal): StopConfirmation {
  return {
    status: 'refused',
    diagnostics: refusal(
      proposal,
      'operator-proposal-changed',
      'The UW proposal changed after it was presented for confirmation',
    ),
  }
}

function deferredRefusal(proposal: PreparedOperatorProposal): StopConfirmation {
  return {
    status: 'deferred',
    diagnostics: refusal(
      proposal,
      'operator-confirmation-deferred',
      'Operator deferred the proposal without taking action',
    ),
  }
}

function declinedRefusal(proposal: PreparedOperatorProposal): StopConfirmation {
  return {
    status: 'refused',
    diagnostics: refusal(proposal, 'operator-confirmation-declined', 'Operator declined the exact UW proposal'),
  }
}

function classifyChoice(
  choice: OperatorChoice,
  escapeMode: EscapeMode,
  proposal: PreparedOperatorProposal,
  displayedDigest: string,
  displayedProposal: string,
): 'hold' | 'confirm' | StopConfirmation {
  if (choice === 'defer' && escapeMode === 'hold') return 'hold'
  if (proposal.digest !== displayedDigest || JSON.stringify(proposal.proposal, null, 2) !== displayedProposal) {
    return changedRefusal(proposal)
  }
  if (choice === 'defer') return deferredRefusal(proposal)
  if (choice !== 'confirm') return declinedRefusal(proposal)
  return 'confirm'
}

async function awaitVisible(slot: Slot, cancelled: Promise<void>, live: () => boolean): Promise<boolean> {
  const waiting = slot.state === 'waiting'
  if (waiting) await Promise.race([slot.granted, cancelled])
  return live() && !slot.signal.aborted && slot.state !== 'done'
}

async function resumeHeld(
  presenter: Presenter,
  slot: Slot,
  cancelled: Promise<void>,
  ctx: ExtensionContext,
  live: () => boolean,
  resolveHeld: () => void,
): Promise<boolean> {
  // Hide is not a freshness decision. SDK custom() disposes before this promise resolves.
  hide(presenter, slot)
  resolveHeld()
  await Promise.race([slot.reopened, cancelled])
  if (!live() || slot.signal.aborted || !here(slot.origin, ctx)) return false
  slot.armReopen()
  return true
}

async function readChoice(drive: ConfirmationDrive<unknown>, slot: Slot): Promise<OperatorChoice | { error: string }> {
  try {
    return await showOperatorProposal(drive.ctx, drive.proposal, drive.detail, slot.signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown UI error'
    return { error: safeOperatorError(message) }
  }
}

async function confirmationTurn<T>(drive: ConfirmationDrive<T>, slot: Slot): Promise<OperatorResult<T> | 'again'> {
  if (!stillRoot(drive.ctx, drive.live()) || !here(slot.origin, drive.ctx)) return drive.unavailable(drive.proposal)
  setPortStatus(drive.presenter, drive.port, slot.origin, 'visible')
  const choice = await readChoice(drive, slot)
  if (typeof choice !== 'string') {
    if (slot.signal.aborted || !drive.live()) return drive.unavailable(drive.proposal)
    drive.failShow()
    return {
      status: 'refused',
      diagnostics: refusal(
        drive.proposal,
        'operator-confirmation-unavailable',
        `Operator confirmation UI failed: ${choice.error}`,
      ),
    }
  }
  if (!stillRoot(drive.ctx, drive.live()) || !here(slot.origin, drive.ctx)) return drive.unavailable(drive.proposal)
  const decision = classifyChoice(
    choice,
    drive.escapeMode,
    drive.proposal,
    drive.displayedDigest,
    drive.displayedProposal,
  )
  if (decision === 'hold') {
    const resumed = await resumeHeld(drive.presenter, slot, drive.cancelled, drive.ctx, drive.live, drive.resolveHeld)
    if (!resumed) return drive.unavailable(drive.proposal)
    return 'again'
  }
  if (decision !== 'confirm') return decision
  if (!here(slot.origin, drive.ctx)) return drive.unavailable(drive.proposal)
  setPortStatus(drive.presenter, drive.port, slot.origin, 'applying')
  drive.releaseSlot(slot)
  // An already-started action is not rolled back when the SDK signal aborts.
  return {
    status: 'confirmed',
    value: await drive.action({
      route: 'omp-native-command',
      operationId: drive.proposal.proposal.operationId,
      proposalDigest: drive.proposal.digest,
      confirmedAt: new Date().toISOString(),
    }),
  }
}

export async function driveConfirmation<T>(drive: ConfirmationDrive<T>): Promise<OperatorResult<T>> {
  const slot = createSlot(drive.port, drive.origin, drive.signal)
  drive.bindSlot(slot)
  if (!here(drive.origin, drive.ctx)) return drive.unavailable(drive.proposal)
  enqueue(drive.presenter, slot)
  if (!(await awaitVisible(slot, drive.cancelled, drive.live))) return drive.unavailable(drive.proposal)
  while (drive.live() && !drive.signal.aborted) {
    const turn = await confirmationTurn(drive, slot)
    if (turn !== 'again') return turn
  }
  return drive.unavailable(drive.proposal)
}

export const unavailable = (proposal: PreparedOperatorProposal): StopConfirmation => ({
  status: 'refused',
  diagnostics: refusal(
    proposal,
    'operator-confirmation-required',
    'An active interactive root command context is required',
  ),
})
