import { composedParentConsentSchema } from '../dist/contracts.js'
import { isRecord } from '../roxabi/feature-engine.ts'
import type { UwProposal } from '../roxabi/uw-contract.ts'
import {
  asked,
  PARTIAL,
  quoted,
  refs,
  refText,
  scopeText,
  strings,
  summaryField,
  unrecognizedWarning,
} from './omp-operator-confirmation-field.ts'

function draftItem(item: unknown): string | null {
  if (!isRecord(item) || typeof item.statement !== 'string') return null
  if (item.kind === 'existing' && typeof item.id === 'string') return `${item.id} — ${item.statement}`
  return item.statement
}

function draftLines(draft: unknown): string[] {
  if (!isRecord(draft)) return []
  const lines: string[] = []
  if (Array.isArray(draft.criteria)) {
    for (const item of draft.criteria) {
      const label = draftItem(item)
      if (label) quoted(lines, 'Critère : ', label)
    }
  }
  if (Array.isArray(draft.invariants)) {
    for (const item of draft.invariants) {
      const label = draftItem(item)
      if (label) quoted(lines, 'Invariant : ', label)
    }
  }
  strings(lines, 'Exclusion : ', draft.exclusions)
  strings(lines, 'Question ouverte : ', draft.openQuestions)
  return lines
}

function normalizationTarget(target: unknown): string {
  if (!isRecord(target) || typeof target.kind !== 'string') return ''
  if (target.kind === 'existing' && typeof target.id === 'string') return target.id
  if (target.kind === 'new' && typeof target.draftKey === 'string') return target.draftKey
  if (target.kind === 'section' && typeof target.section === 'string') return target.section
  if (typeof target.index === 'number') return String(target.index)
  return ''
}

const normalizationLabel: Record<string, string> = {
  kept: 'Conservé : ',
  reworded: 'Reformulé : ',
  removed: 'Retiré : ',
  new: 'Ajouté : ',
}

function normalizationLines(decisions: unknown): string[] {
  if (!Array.isArray(decisions)) return []
  const lines: string[] = []
  for (const decision of decisions) {
    if (!isRecord(decision) || typeof decision.kind !== 'string') continue
    const target = normalizationTarget(decision.target)
    const reason = typeof decision.reason === 'string' ? decision.reason : ''
    const fact = [decision.kind, target, reason].filter(Boolean).join(' — ')
    quoted(lines, normalizationLabel[decision.kind] ?? 'Décision : ', fact)
  }
  return lines
}

function allocationLines(allocation: unknown): string[] {
  if (!isRecord(allocation)) return []
  const lines: string[] = []
  if (Array.isArray(allocation.assignments)) {
    for (const item of allocation.assignments) {
      if (!isRecord(item) || typeof item.id !== 'string') continue
      const key = typeof item.draftKey === 'string' ? item.draftKey : ''
      quoted(lines, 'Critère attribué : ', key ? `${item.id} (${key})` : item.id)
    }
  }
  strings(lines, 'Critère retiré : ', allocation.retirements)
  return lines
}

function relationLines(writes: unknown): string[] {
  if (!isRecord(writes)) return []
  const lines: string[] = []
  const relations = writes.relations
  if (isRecord(relations)) {
    if ('parent' in relations) {
      if (relations.parent === null) lines.push('Relation : aucun parent.')
      else {
        const parent = refText(relations.parent)
        if (parent) quoted(lines, 'Parent : ', parent)
      }
    }
    refs(lines, 'Enfant ajouté : ', relations.addChildren)
    refs(lines, 'Enfant retiré : ', relations.removeChildren)
    refs(lines, 'Bloquant ajouté : ', relations.addBlockers)
    refs(lines, 'Bloquant retiré : ', relations.removeBlockers)
  }
  if (isRecord(writes.labels)) {
    strings(lines, 'Label ajouté : ', writes.labels.add)
    strings(lines, 'Label retiré : ', writes.labels.remove)
  }
  return lines
}

function creationLines(creation: unknown): string[] {
  if (!isRecord(creation) || typeof creation.kind !== 'string') return []
  if (creation.kind === 'sister') {
    const lines = [summaryField('Création : ', `sœur de ${scopeText(creation.original)}`)]
    if (creation.relation === 'original-blocked-by-sister')
      lines.push("Relation : la demande d'origine sera bloquée par la sœur.")
    else if (creation.relation === 'sister-blocked-by-original')
      lines.push("Relation : la sœur sera bloquée par la demande d'origine.")
    return lines
  }
  if (creation.kind === 'report-promotion') {
    const report =
      isRecord(creation.report) && typeof creation.report.recordId === 'string' ? creation.report.recordId : ''
    return [summaryField('Création : ', report ? `promotion du rapport ${report}` : 'promotion de rapport')]
  }
  if (creation.kind === 'operator-create') return [summaryField('Création : ', 'création opérateur')]
  return [summaryField('Création : ', creation.kind)]
}

function parentAcceptanceLines(proposal: object): string[] {
  if (!('parentAcceptance' in proposal)) return []
  const acceptance = proposal.parentAcceptance
  if (!isRecord(acceptance)) return []
  const lines: string[] = []
  if (typeof acceptance.parentOperationId === 'string')
    quoted(lines, 'Acceptation parent : ', acceptance.parentOperationId)
  const consent = composedParentConsentSchema.safeParse(acceptance)
  if (!consent.success || !consent.data.exactInputs.proposed.coverage) return lines
  const proposed = consent.data.exactInputs.proposed
  for (const assignment of proposed.coverage?.assignments ?? []) {
    const children = assignment.children
      .map((child) => {
        if (!('kind' in child)) return `${child.repository} : ${child.target}`
        const planned = proposed.children.find((item) => 'kind' in item && item.operationId === child.operationId)
        return `nouveau / en attente : ${planned && 'kind' in planned ? planned.plan.title : child.operationId}`
      })
      .join(', ')
    quoted(
      lines,
      'Couverture parent : ',
      `${proposed.coverage?.parent.uw.target} — ${assignment.criterion} → ${children}`,
    )
  }
  return lines
}

function uwScope(proposal: UwProposal): string {
  if (proposal.target?.kind === 'create')
    return typeof proposal.target.repository === 'string' ? proposal.target.repository : ''
  if (proposal.target?.kind === 'existing') return scopeText(proposal.target.uw)
  return ''
}

function uwQuestion(proposal: UwProposal): string {
  const scope = uwScope(proposal)
  if (proposal.operation === 'create') return asked('Créer la demande dans ', scope)
  if (proposal.operation === 'normalize') return asked('Normaliser et écrire la spécification de ', scope)
  if (proposal.operation === 'write') return asked('Écrire la spécification de ', scope)
  return unrecognizedWarning(scope)
}

function uwEffect(operation: Exclude<UwProposal['operation'], 'accept-material'>): string {
  if (operation === 'create')
    return "Effet : créer la demande avec le titre, le corps, les labels et les relations proposés, puis relire. L'identité n'est publiée que s'il y a des attributions. Une création peut rester incertaine ou partielle."
  return "Effet : mettre à jour le titre, le corps, les labels et les relations, puis relire. L'identité n'est publiée que s'il y a des attributions, ou des retraits sans prédécesseur accepté."
}

export function uwLines(proposal: UwProposal): string[] {
  const lines = ['Proposition à examiner', uwQuestion(proposal)]
  if (proposal.operation === 'accept-material') {
    if (typeof proposal.title === 'string') quoted(lines, 'Titre : ', proposal.title)
    lines.push(...draftLines(proposal.draft), ...relationLines(proposal.writes))
    return lines
  }
  lines.push(summaryField('Opération : ', proposal.operation))
  if (typeof proposal.title === 'string') quoted(lines, 'Titre : ', proposal.title)
  if (proposal.target?.kind === 'create') quoted(lines, 'Périmètre : ', proposal.target.repository)
  else if (proposal.target?.kind === 'existing') quoted(lines, 'Cible : ', scopeText(proposal.target.uw))
  if (typeof proposal.tier === 'string') quoted(lines, 'Niveau proposé : ', proposal.tier)
  lines.push(...draftLines(proposal.draft), ...relationLines(proposal.writes))
  lines.push(...normalizationLines(proposal.normalization), ...allocationLines(proposal.allocation))
  lines.push(...creationLines(proposal.creation), ...parentAcceptanceLines(proposal))
  lines.push(uwEffect(proposal.operation), PARTIAL)
  return lines
}
