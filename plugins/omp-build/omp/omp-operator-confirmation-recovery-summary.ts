import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { scopeText, summaryField } from './omp-operator-confirmation-field.ts'

type RecoveryProposal = Extract<PreparedOperatorProposal['proposal'], { format: 'omp-build-fix-recovery-proposal/1' }>

export function recoveryLines(proposal: RecoveryProposal): string[] {
  const lines = [
    proposal.phase === 'adopt-decision'
      ? 'Reprendre la décision de correction existante'
      : 'Clore sans décision l’essai de correction interrompu',
    summaryField('UW : ', scopeText(proposal.uw)),
    summaryField('PR : ', scopeText(proposal.pullRequest)),
    summaryField('Owner interrompu : ', proposal.opened.recordId),
    summaryField('Constat de clôture : ', proposal.settled.recordId),
    summaryField('Tête observée : ', proposal.observation.pullRequest.candidateGitSHA),
  ]
  if (proposal.phase === 'close-publication') {
    lines.push(summaryField('Publication source : ', proposal.target.source.state))
    lines.push(
      summaryField(
        'Source réservée : ',
        proposal.target.source.state === 'complete'
          ? proposal.target.source.record.identity.recordId
          : proposal.target.source.reservation.recordId,
      ),
    )
    lines.push(summaryField('Publication demande : ', proposal.target.request.state))
    lines.push(summaryField('Demande réservée : ', proposal.target.request.reservation.recordId))
    lines.push('Aucune nouvelle correction ne sera lancée par cette clôture.')
  } else {
    lines.push(summaryField('Demande existante : ', proposal.target.request.identity.recordId))
    if (proposal.phase === 'adopt-decision') {
      lines.push(summaryField('Décision existante : ', proposal.target.decision.identity.recordId))
      lines.push('La reprise conserve la même demande et la même décision, ainsi que leurs obligations et limites.')
    } else {
      lines.push(
        summaryField(
          'Décision non confirmée : ',
          proposal.target.decision.state === 'not-reserved'
            ? 'aucune réservation'
            : proposal.target.decision.reservation.recordId,
        ),
      )
      lines.push('Aucune nouvelle correction ne sera lancée par cette clôture.')
    }
  }
  lines.push('Les effets locaux existants ne sont ni annulés ni supprimés.')
  return lines
}
