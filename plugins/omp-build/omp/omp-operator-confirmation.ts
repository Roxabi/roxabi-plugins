import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { retainActionRecordSync } from './action-communication.ts'

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

function decisionFacts(prepared: PreparedOperatorProposal): string[] {
  const proposal = prepared.proposal
  if (!('target' in proposal)) {
    return [
      `operation: accept-material`,
      `repository: ${JSON.stringify(proposal.uw.repository)}`,
      `UW: ${JSON.stringify(proposal.uw.target)}`,
      `classification: ${JSON.stringify(proposal.classification)}`,
      `assessment: ${JSON.stringify(proposal.assessment)}`,
    ]
  }
  const target = proposal.target
  const repository = target.kind === 'existing' ? target.uw.repository : target.repository
  const uw = target.kind === 'existing' ? target.uw.target : 'new'
  return [
    `operation: ${proposal.operation}`,
    `repository: ${JSON.stringify(repository)}`,
    `UW: ${JSON.stringify(uw)}`,
    `title: ${JSON.stringify(proposal.title)}`,
    ...(proposal.normalization ?? []).map((decision) => `change: ${JSON.stringify(decision)}`),
  ]
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
      const detail = retainActionRecordSync(ctx, 'proposal', proposal.proposal)
      const facts = [
        `digest: ${displayedDigest}`,
        `operationId: ${JSON.stringify(proposal.proposal.operationId)}`,
        ...decisionFacts(proposal),
        'credentialMode: procedural-fallback',
        `detail: ${detail}`,
        'options: confirm the exact proposal, or decline',
      ]
      try {
        confirmed = await ctx.ui.confirm('Confirm UW proposal', facts.join('\n'))
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
