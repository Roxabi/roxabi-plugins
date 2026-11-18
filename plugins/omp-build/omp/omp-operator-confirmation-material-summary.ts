import type { MaterialAcceptanceProposal } from '../engine/workflow-spec-assessment.ts'
import { isRecord } from '../roxabi/feature-engine.ts'
import { asked, PARTIAL, quoted, scopeText, summaryField } from './omp-operator-confirmation-field.ts'

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

export function materialLines(proposal: MaterialAcceptanceProposal): string[] {
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
