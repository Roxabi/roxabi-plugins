import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { retainActionRecordSync } from './action-communication.ts'

/** Per-command capability. Composition cancels it on command/session liveness loss. */
export type CommandOperatorPort = OperatorPort & { cancel(): void }

function refusal(proposal: PreparedOperatorProposal, code: string, message: string): readonly UwDiagnostic[] {
  const target = proposal.proposal
  if ('target' in target) {
    if (target.target.kind === 'create')
      return [{ code, message, location: { kind: 'repository', repository: target.target.repository }, related: [] }]
    return [{ code, message, location: { kind: 'native', uw: target.target.uw, connection: 'state' }, related: [] }]
  }
  const uw = 'origin' in target ? target.origin : target.uw
  return [{ code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }]
}

function decisionFacts(prepared: PreparedOperatorProposal): string[] {
  const proposal = prepared.proposal
  if ('operation' in proposal && proposal.operation === 'adjudicate-cause') {
    return [
      'operation: adjudicate-cause',
      `repository: ${JSON.stringify(proposal.uw.repository)}`,
      `UW: ${JSON.stringify(proposal.uw.target)}`,
      `pending: ${JSON.stringify(proposal.pending)}`,
      `rejected findings: ${JSON.stringify(proposal.rejectedFindingIds)}`,
      `judgment: ${JSON.stringify(proposal.judgment)}`,
      `reason: ${JSON.stringify(proposal.reason)}`,
      `references: ${JSON.stringify(proposal.references)}`,
    ]
  }
  if (proposal.format === 'omp-build-cause-dependency-adjustment/1') {
    return [
      'operation: adjust-cause-dependency',
      `repository: ${JSON.stringify(proposal.origin.repository)}`,
      `UW: ${JSON.stringify(proposal.origin.target)}`,
      `disposition: ${JSON.stringify(proposal.disposition)}`,
      `receipt: ${JSON.stringify(proposal.receipt)}`,
      `causal change: ${JSON.stringify(proposal.change)}`,
      `native effect: ${JSON.stringify(proposal.nativeEffect)}`,
      `reason: ${JSON.stringify(proposal.reason)}`,
      `references: ${JSON.stringify(proposal.references)}`,
    ]
  }
  if (proposal.format === 'omp-build-uw-reopen/1') {
    return [
      'operation: reopen',
      `repository: ${JSON.stringify(proposal.uw.repository)}`,
      `UW: ${JSON.stringify(proposal.uw.target)}`,
      `accepted: ${JSON.stringify(proposal.accepted)}`,
      `before state: ${JSON.stringify(proposal.before.nativeState)}`,
      `native effect: ${JSON.stringify(proposal.effect)}`,
    ]
  }
  if (proposal.format === 'omp-build-uw-abandon/1') {
    return [
      'operation: abandon',
      `repository: ${JSON.stringify(proposal.uw.repository)}`,
      `UW: ${JSON.stringify(proposal.uw.target)}`,
      `mandate: ${JSON.stringify(proposal.mandate)}`,
      `accepted: ${JSON.stringify(proposal.accepted)}`,
    ]
  }
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
    ...(proposal.creation === null || proposal.creation === undefined || proposal.creation.kind === 'operator-create'
      ? []
      : [`creation: ${JSON.stringify(proposal.creation)}`, `framing: ${JSON.stringify(proposal.draft)}`]),
    ...('parentAcceptance' in proposal && proposal.parentAcceptance != null
      ? [`parent acceptance: ${JSON.stringify(proposal.parentAcceptance)}`]
      : []),
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
