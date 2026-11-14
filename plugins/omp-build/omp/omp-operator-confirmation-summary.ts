import type { CauseDependencyAdjustmentProposal } from '../engine/cause-dependency-adjustment-schema.ts'
import type { CauseAdjudicationProposal } from '../engine/cause-disposition-schema.ts'
import type { MaterialAcceptanceProposal } from '../engine/workflow-spec-assessment.ts'
import { isRecord } from '../roxabi/feature-engine.ts'
import type {
  PreparedOperatorProposal,
  PreparedUwAbandon,
  PreparedUwReopen,
  UwProposal,
} from '../roxabi/uw-contract.ts'
import {
  asked,
  PARTIAL,
  quoted,
  refs,
  scopeText,
  strings,
  summaryField,
  unrecognizedWarning,
} from './omp-operator-confirmation-field.ts'
import { framingSummary } from './omp-operator-confirmation-framing.ts'
import { uwLines } from './omp-operator-confirmation-spec-summary.ts'

type Proposal = PreparedOperatorProposal['proposal']

function recognizedScope(proposal: object): string {
  if ('uw' in proposal) {
    const text = scopeText(proposal.uw)
    if (text) return text
  }
  if ('origin' in proposal) {
    const text = scopeText(proposal.origin)
    if (text) return text
  }
  if (!('target' in proposal) || !isRecord(proposal.target)) return ''
  if (proposal.target.kind === 'create' && typeof proposal.target.repository === 'string')
    return proposal.target.repository
  return scopeText(proposal.target.uw)
}

function statementFor(snapshot: unknown, id: string): string {
  if (!isRecord(snapshot) || !isRecord(snapshot.spec)) return id
  const items = [
    ...(Array.isArray(snapshot.spec.criteria) ? snapshot.spec.criteria : []),
    ...(Array.isArray(snapshot.spec.invariants) ? snapshot.spec.invariants : []),
  ]
  for (const item of items) {
    if (isRecord(item) && item.id === id && typeof item.statement === 'string') return `${id} — ${item.statement}`
  }
  return id
}

function idFacts(lines: string[], prefix: string, ids: unknown, snapshot: unknown): void {
  if (!Array.isArray(ids)) return
  for (const id of ids) if (typeof id === 'string') quoted(lines, prefix, statementFor(snapshot, id))
}

function coverageLines(coverage: unknown, children: unknown): string[] {
  if (!isRecord(coverage) || !Array.isArray(coverage.assignments)) return []
  const planned = Array.isArray(children) ? children : []
  const parent = isRecord(coverage.parent) && isRecord(coverage.parent.uw) ? scopeText(coverage.parent.uw) : ''
  const lines: string[] = []
  for (const assignment of coverage.assignments) {
    if (!isRecord(assignment) || typeof assignment.criterion !== 'string' || !Array.isArray(assignment.children))
      continue
    const names = assignment.children
      .map((child) => {
        if (!isRecord(child)) return ''
        if (!('kind' in child)) return scopeText(child)
        const match = planned.find((item) => isRecord(item) && 'kind' in item && item.operationId === child.operationId)
        const title =
          isRecord(match) && isRecord(match.plan) && typeof match.plan.title === 'string' ? match.plan.title : ''
        return title ? `nouveau / en attente : ${title}` : `nouveau / en attente : ${String(child.operationId ?? '')}`
      })
      .filter(Boolean)
      .join(', ')
    quoted(lines, 'Couverture parent : ', `${parent} — ${assignment.criterion} → ${names}`)
  }
  return lines
}

function abandonLines(proposal: PreparedUwAbandon['proposal']): string[] {
  return [
    'Proposition à examiner',
    asked('Abandonner le mandat de ', scopeText(proposal.uw)),
    summaryField('Opération : ', 'abandon'),
    summaryField('Cible : ', scopeText(proposal.uw)),
    summaryField('Mandat : ', proposal.mandate.recordId),
    "L'ancien mandat exact ne pourra plus être repris. Cette confirmation ne crée pas de successeur.",
    "La demande n'est pas écartée.",
    "Aucun fichier ni branche n'est supprimé.",
    "Effet : ajouter le contrôle d'abandon exact, puis vérifier sa relecture.",
    PARTIAL,
  ]
}

function reopenLines(proposal: PreparedUwReopen['proposal']): string[] {
  const state = proposal.before?.nativeState
  const current =
    state && typeof state.state === 'string'
      ? `${state.state} / ${typeof state.stateReason === 'string' ? state.stateReason : 'sans motif'}`
      : ''
  return [
    'Proposition à examiner',
    asked('Rouvrir ', scopeText(proposal.uw)),
    summaryField('Opération : ', 'reopen'),
    summaryField('Cible : ', scopeText(proposal.uw)),
    ...(current ? [summaryField('État actuel : ', current)] : []),
    summaryField('Effet : ', 'écrire OPEN / REOPENED, puis vérifier la relecture'),
    "Cette réouverture ne fabrique pas les preuves manquantes de critères, de revue, de merge ou d'intégration parent.",
    "La demande n'est pas fermée par cette confirmation.",
    PARTIAL,
  ]
}

const mechanicalNotes = [
  ['exclusionsChanged', 'Les exclusions changent.'],
  ['tierChanged', 'Le niveau change.'],
  ['childrenChanged', 'Les engagements enfants changent.'],
  ['inheritanceChanged', "L'héritage change."],
  ['coverageChanged', 'La couverture parent change.'],
  ['sectionsOrOrderChanged', "Le texte ou l'ordre des sections change."],
] as const

function materialFactLines(exact: MaterialAcceptanceProposal['exactInputs']): string[] {
  const lines: string[] = []
  const mechanical = exact.mechanical
  const proposed = exact.proposed
  const accepted = exact.accepted
  if (mechanical) {
    idFacts(lines, 'Critère ajouté : ', mechanical.added, proposed?.snapshot)
    idFacts(lines, 'Critère retiré : ', mechanical.removed, accepted?.snapshot)
    idFacts(lines, 'Énoncé modifié : ', mechanical.changedStatements, proposed?.snapshot)
    lines.push(...mechanicalNotes.filter(([key]) => mechanical[key]).map(([, note]) => note))
  }
  if (proposed?.coverage) lines.push(...coverageLines(proposed.coverage, proposed.children))
  return lines
}

function materialLines(proposal: MaterialAcceptanceProposal): string[] {
  const lines = [
    'Proposition à examiner',
    asked("Accepter l'évaluation exacte de ", scopeText(proposal.uw)),
    summaryField('Opération : ', 'accept-material'),
    summaryField('Cible : ', scopeText(proposal.uw)),
    summaryField('Classement : ', proposal.classification),
    summaryField('Évaluation : ', proposal.assessment.recordId),
  ]
  const exact = proposal.exactInputs
  if (exact && typeof exact === 'object') lines.push(...materialFactLines(exact))
  lines.push("Effet : publier le contrôle d'acceptation exact après revérification, puis relire la chaîne acceptée.")
  lines.push("Cela n'écrit pas le corps de la demande, ne la ferme pas et n'autorise pas l'atterrissage.", PARTIAL)
  return lines
}

function adjustmentLines(proposal: CauseDependencyAdjustmentProposal): string[] {
  const replacing = proposal.change.kind === 'replace'
  const lines = [
    'Proposition à examiner',
    asked(
      replacing ? "Remplacer l'obligation causale de " : "Retirer l'obligation causale de ",
      scopeText(proposal.origin),
    ),
    summaryField('Opération : ', 'adjust-cause-dependency'),
    summaryField('Cible : ', scopeText(proposal.origin)),
    summaryField('Changement : ', proposal.change.kind),
  ]
  if (proposal.change.kind === 'replace') quoted(lines, 'Nouveau bloquant : ', scopeText(proposal.change.blocker))
  if (proposal.nativeEffect?.kind === 'update-blockers') {
    refs(lines, 'Bloquant retiré : ', proposal.nativeEffect.remove)
    refs(lines, 'Bloquant ajouté : ', proposal.nativeEffect.add)
  } else lines.push('Aucun changement de bloquant natif.')
  if (proposal.reason) quoted(lines, 'Motif : ', proposal.reason)
  lines.push(
    'Effet : appliquer seulement le delta natif déclaré, relire cet effet, puis publier le contrôle authentifié.',
  )
  lines.push("Un refus n'écrit rien. Un effet non confirmé reste partiel. La demande n'est pas fermée.", PARTIAL)
  return lines
}

function judgmentLines(judgment: CauseAdjudicationProposal['judgment']): string[] {
  if (!judgment) return []
  const lines: string[] = []
  for (const [key, label] of [
    ['necessary', 'Nécessaire : '],
    ['urgent', 'Urgent : '],
    ['tooLarge', 'Trop grand : '],
  ] as const) {
    const item = judgment[key]
    const value = typeof item.value === 'boolean' ? String(item.value) : 'indéterminé'
    const reason = item.reason ? ` — ${item.reason}` : ''
    quoted(lines, label, `${item.state} / ${value}${reason}`)
  }
  return lines
}

function adjudicationLines(proposal: CauseAdjudicationProposal): string[] {
  const lines = [
    'Proposition à examiner',
    asked('Trancher la cause en attente de ', scopeText(proposal.uw)),
    summaryField('Opération : ', 'adjudicate-cause'),
    summaryField('Cible : ', scopeText(proposal.uw)),
    summaryField('Cause en attente : ', proposal.pending.recordId),
  ]
  strings(lines, 'Constat rejeté : ', proposal.rejectedFindingIds)
  if (proposal.reason) quoted(lines, 'Motif : ', proposal.reason)
  lines.push(...judgmentLines(proposal.judgment))
  lines.push("Effet : publier l'intention confirmée, puis la disposition successeur après relecture.")
  lines.push("Aucune sœur n'est créée et la demande n'est pas fermée.", PARTIAL)
  return lines
}

function interruptionLines(proposal: Record<string, unknown>): string[] {
  const lines = [
    asked('Résoudre l’interruption de ', scopeText(proposal.uw)),
    summaryField('Action : ', typeof proposal.action === 'string' ? proposal.action : ''),
    summaryField('Action ID : ', typeof proposal.actionId === 'string' ? proposal.actionId : ''),
  ]
  if (isRecord(proposal.start) && typeof proposal.start.recordId === 'string') {
    lines.push(summaryField('START : ', proposal.start.recordId))
    lines.push(summaryField('Scope START : ', scopeText(proposal.start.scope)))
  }
  if (isRecord(proposal.result) && typeof proposal.result.recordId === 'string') {
    lines.push(summaryField('RESULT : ', proposal.result.recordId))
    lines.push(summaryField('Scope RESULT : ', scopeText(proposal.result.scope)))
  } else lines.push('START orphelin : aucun RESULT.')
  lines.push('L’hôte a établi que cette action native n’a pas été envoyée aux exécutants.')
  lines.push('Les préparatifs déjà effectués ne sont pas annulés ; les vérifications ordinaires restent nécessaires.')
  lines.push('Le flux reste en pause ; aucune reprise automatique.')
  return lines
}

function unsupportedLines(proposal: Proposal): string[] {
  return ['Proposition à examiner', unrecognizedWarning(recognizedScope(proposal))]
}

function fallbackLines(proposal: Proposal): string[] {
  const operation = 'operation' in proposal && typeof proposal.operation === 'string' ? proposal.operation : undefined
  if (operation === 'adjudicate-cause') return adjudicationLines(proposal as CauseAdjudicationProposal)
  if (operation === 'normalize' || operation === 'write' || operation === 'create' || operation === 'accept-material')
    return uwLines(proposal as UwProposal)
  if ('effect' in proposal && isRecord(proposal.effect) && proposal.effect.stateReason === 'REOPENED')
    return reopenLines(proposal as PreparedUwReopen['proposal'])
  if (
    'change' in proposal &&
    isRecord(proposal.change) &&
    (proposal.change.kind === 'withdraw' || proposal.change.kind === 'replace')
  )
    return adjustmentLines(proposal as CauseDependencyAdjustmentProposal)
  if ('classification' in proposal && 'assessment' in proposal)
    return materialLines(proposal as MaterialAcceptanceProposal)
  if ('mandate' in proposal && 'uw' in proposal && !('effect' in proposal))
    return abandonLines(proposal as PreparedUwAbandon['proposal'])
  return unsupportedLines(proposal)
}

/** Human decision lines. Technical JSON stays in the dialog details. */
export function proposalSummary(prepared: PreparedOperatorProposal): string[] {
  const proposal = prepared.proposal
  const candidate: unknown = proposal
  if (isRecord(candidate) && candidate.format === 'omp-build-interruption-resolution/2')
    return interruptionLines(candidate)
  if (proposal.format === 'omp-build-uw-framing/1') return framingSummary(proposal)
  if (proposal.format === 'omp-build-uw-abandon/1') return abandonLines(proposal)
  if (proposal.format === 'omp-build-uw-reopen/1') return reopenLines(proposal)
  if (proposal.format === 'omp-build-material-acceptance/2') return materialLines(proposal)
  if (proposal.format === 'omp-build-cause-dependency-adjustment/1') return adjustmentLines(proposal)
  if (proposal.format === 'omp-build-cause-adjudication-proposal/1') return adjudicationLines(proposal)
  if (proposal.format === 'omp-build-uw-proposal/1') return uwLines(proposal)
  return fallbackLines(proposal)
}
