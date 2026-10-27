import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'

/** Per-command capability. Composition cancels it on command/session liveness loss. */
export type CommandOperatorPort = OperatorPort & { cancel(): void }

function refusal(proposal: PreparedOperatorProposal, code: string, message: string): readonly UwDiagnostic[] {
  const uw =
    'target' in proposal.proposal
      ? proposal.proposal.target.kind === 'existing'
        ? proposal.proposal.target.uw
        : { repository: proposal.proposal.target.repository, target: `${proposal.proposal.target.repository}#0` }
      : proposal.proposal.uw
  return [{ code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }]
}

/** Captures the actual root command context; argv and child output cannot mint its confirmation. */
export function createOperatorConfirmation(ctx: ExtensionContext): CommandOperatorPort {
  let live = true
  let consumed = false
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
    },
    async executeConfirmed(proposal, action) {
      if (consumed || !live || !root() || !ctx.hasUI || ctx.mode !== 'tui') return unavailable(proposal)
      consumed = true
      let confirmed = false
      const displayedDigest = proposal.digest
      const displayedProposal = JSON.stringify(proposal.proposal, null, 2)
      try {
        confirmed = await ctx.ui.confirm('Confirm UW proposal', `${displayedDigest}\n\n${displayedProposal}`)
      } catch {
        live = false
        return {
          status: 'refused',
          diagnostics: refusal(
            proposal,
            'operator-confirmation-declined',
            'Operator confirmation was unavailable or cancelled',
          ),
        }
      }
      if (!confirmed)
        return {
          status: 'refused',
          diagnostics: refusal(proposal, 'operator-confirmation-declined', 'Operator declined the exact UW proposal'),
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
