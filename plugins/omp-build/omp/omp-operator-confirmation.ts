import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { retainActionRecordSync } from './action-communication.ts'
import { showOperatorProposal } from './omp-operator-confirmation-dialog.ts'

/** Per-command capability. Composition cancels it on command/session liveness loss. */
export type CommandOperatorPort = OperatorPort & { cancel(): void }

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

/** Captures the actual root command context; argv and child output cannot mint its confirmation. */
export function createOperatorConfirmation(ctx: ExtensionContext): CommandOperatorPort {
  let live = true
  let consumed = false
  const cancellation = new AbortController()
  const root = (): boolean => ctx.agent.kind === 'main' && ctx.agent.depth === 0
  const unavailable = (proposal: PreparedOperatorProposal) => ({
    status: 'refused' as const,
    diagnostics: refusal(
      proposal,
      'operator-confirmation-required',
      'An active interactive root command context is required',
    ),
  })
  return {
    cancel() {
      live = false
      cancellation.abort()
    },
    async executeConfirmed(proposal, action) {
      if (consumed || !live || !root() || !ctx.hasUI || ctx.mode !== 'tui') return unavailable(proposal)
      consumed = true
      let choice: 'confirm' | 'refuse' | 'defer'
      const displayedDigest = proposal.digest
      const displayedProposal = JSON.stringify(proposal.proposal, null, 2)
      const detail = retainActionRecordSync(ctx, 'proposal', proposal.proposal)
      try {
        choice = await showOperatorProposal(ctx, proposal, detail, cancellation.signal)
      } catch {
        live = false
        return unavailable(proposal)
      }
      if (!live || !root() || !ctx.hasUI || ctx.mode !== 'tui') return unavailable(proposal)
      if (proposal.digest !== displayedDigest || JSON.stringify(proposal.proposal, null, 2) !== displayedProposal)
        return {
          status: 'refused',
          diagnostics: refusal(
            proposal,
            'operator-proposal-changed',
            'The UW proposal changed after it was presented for confirmation',
          ),
        }
      if (choice === 'defer')
        return {
          status: 'deferred',
          diagnostics: refusal(
            proposal,
            'operator-confirmation-deferred',
            'Operator deferred the proposal without taking action',
          ),
        }
      if (choice !== 'confirm')
        return {
          status: 'refused',
          diagnostics: refusal(proposal, 'operator-confirmation-declined', 'Operator declined the exact UW proposal'),
        }
      return {
        status: 'confirmed',
        value: await action({
          route: 'omp-native-command',
          operationId: proposal.proposal.operationId,
          proposalDigest: proposal.digest,
          confirmedAt: new Date().toISOString(),
        }),
      }
    },
  }
}
