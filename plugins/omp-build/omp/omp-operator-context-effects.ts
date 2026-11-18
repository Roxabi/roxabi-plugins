import type {
  ContextEffectIntent,
  ContextEffectReview,
  ContextLocalFileState,
} from '../engine/context-effect-review-schema.ts'
import { matchingContextEffectReports } from '../roxabi/context-effect-report-views.ts'
import type { PreparedOperatorProposal } from '../roxabi/uw-contract.ts'

type Conclusion = ContextEffectIntent['negatives'][number]['reportConclusion']

function conclusionText(conclusion: Conclusion): string {
  const kind =
    conclusion.kind === 'none-identified'
      ? 'aucun effet de ressource identifié par la revue humaine'
      : conclusion.kind === 'unresolved'
        ? 'effet non résolu'
        : `fichiers nommés ${JSON.stringify(conclusion.resourceKeys)}`
  return `${kind} — ${JSON.stringify(conclusion.reason)}`
}

function fileStateText(state: ContextLocalFileState): string {
  return state.kind === 'absent'
    ? 'absent'
    : `fichier régulier, ${state.bytes} octets, mode ${state.mode.toString(8)}, SHA-256 ${state.sha256}`
}

export function contextEffectSummary(review: ContextEffectReview): string[] {
  return [
    `Observateur local de cette confirmation : ${review.namespace.id}`,
    'Le lien avec les effets historiques est votre attribution, pas une identité de machine prouvée.',
    ...review.intent.negatives.flatMap((negative) => [
      `Rapport ${JSON.stringify(negative.source.record.recordId)} : ${conclusionText(negative.reportConclusion)}`,
      `Inventaire ${negative.inventory.kind} ; ${negative.calls.length} appels revus. Une capture absente ne prouve pas zéro appel.`,
      ...negative.calls.map(
        (call) => `Appel ${JSON.stringify(call.toolCallId)} [${call.ordinal}] : ${conclusionText(call.conclusion)}`,
      ),
    ]),
    ...review.resources.map(
      (resource) => `État nommé vérifié ${JSON.stringify(resource.absolutePath)} : ${fileStateText(resource.state)}`,
    ),
    'Confirmer accepte ces attributions et ces états nommés ; aucune restauration ni suppression n’est exécutée.',
    'Les observations sont des lectures ponctuelles, pas une isolation du système de fichiers.',
    'Détails contient les rapports conservés complets, les appels observés et les états attendus/observés.',
  ]
}

/** Full conserved reports are shown locally, not duplicated in the persisted proposal. */
export function contextEffectReportDetails(prepared: PreparedOperatorProposal): string[] {
  if (prepared.proposal.format !== 'omp-build-context-succession/1') return []
  const reports = 'effectReports' in prepared ? prepared.effectReports : undefined
  if (!matchingContextEffectReports(prepared.proposal, reports))
    throw new Error('context-effect-report-display-unconfirmed')
  return ['Rapports conservés complets — sources exactes de la revue humaine', JSON.stringify(reports, null, 2)]
}
