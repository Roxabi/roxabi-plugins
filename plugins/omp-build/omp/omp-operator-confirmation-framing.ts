import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import { accountingEffects } from './omp-operator-confirmation-accounting.ts'
import { summaryField } from './omp-operator-confirmation-field.ts'

type Member = FramingProposal['input']['members'][number]
type Plan = FramingProposal['members'][number]

function identityEffects(plan: Plan): string[] {
  if (!plan.allocation) return []
  const lines: string[] = []
  const before = [
    ...(plan.nativeAnalysis?.analysis.criterionSources ?? []),
    ...(plan.nativeAnalysis?.analysis.invariantSources ?? []),
  ]
  const after = [...plan.allocation.spec.criteria, ...plan.allocation.spec.invariants]
  for (const id of plan.allocation.retirements) {
    const item = before.find((entry) => entry.id === id)
    lines.push(summaryField('  Identité retirée : ', `${id}${item ? ` — ${item.statement}` : ''}`))
  }
  for (const assignment of plan.allocation.assignments) {
    const item = after.find((entry) => entry.id === assignment.id)
    lines.push(summaryField('  Nouvelle identité : ', `${assignment.id}${item ? ` — ${item.statement}` : ''}`))
  }
  for (const item of after) {
    const previous = before.find((entry) => entry.id === item.id)
    if (previous && previous.statement !== item.statement)
      lines.push(
        summaryField('  Identité avant : ', `${item.id} — ${previous.statement}`),
        summaryField('  Identité après : ', `${item.id} — ${item.statement}`),
      )
  }
  return lines
}

function memberEffects(member: Member, plan: Plan | undefined): string[] {
  const scope = member.slot.kind === 'new' ? member.slot.repository : member.slot.uw.target
  const action = member.slot.kind === 'new' ? 'Créer' : 'Modifier'
  const lines = [summaryField(`${action} : `, member.title), summaryField('  Périmètre : ', scope)]
  if (member.slot.kind === 'existing') {
    lines.push(
      summaryField(
        '  Effet : ',
        `remplacer le titre et le corps de ${scope} par ${member.title} et la spécification proposée`,
      ),
    )
    const observed = member.slot.observed
    if (observed.nativeParent) lines.push(summaryField('  Parent actuel : ', observed.nativeParent.target))
    if (observed.children.length)
      lines.push(summaryField('  Enfants actuels : ', observed.children.map((child) => child.target).join(', ')))
    if (observed.blockers.length)
      lines.push(summaryField('  Blocages actuels : ', observed.blockers.map((blocker) => blocker.target).join(', ')))
  }
  if (plan?.tier) lines.push(summaryField('  Niveau proposé : ', plan.tier))
  if (member.kind === 'wayfinder') return [...lines, summaryField('  Effet : ', `publier le repère ${member.label}`)]
  lines.push('  Effet : publier la spécification et les relations proposées')
  if (plan) lines.push(...identityEffects(plan))
  if (member.labels.add.length) lines.push(summaryField('  Labels à ajouter : ', member.labels.add.join(', ')))
  if (member.labels.remove.length) lines.push(summaryField('  Labels à retirer : ', member.labels.remove.join(', ')))
  return lines
}

function memberContents(member: Member): string[] {
  const lines = [summaryField('Détails métier : ', member.title)]
  if (member.kind === 'wayfinder') return [...lines, summaryField('  Contenu du repère : ', member.body)]
  for (const item of member.draft.criteria) lines.push(summaryField('  Critère : ', item.statement))
  for (const item of member.draft.invariants) lines.push(summaryField('  Invariant : ', item.statement))
  for (const item of member.draft.exclusions) lines.push(summaryField('  Exclusion : ', item))
  for (const item of member.draft.openQuestions) lines.push(summaryField('  Question ouverte : ', item))
  if (member.draft.sections.origin) lines.push(summaryField('  Origine : ', member.draft.sections.origin))
  if (member.draft.sections.context) lines.push(summaryField('  Contexte : ', member.draft.sections.context))
  if (member.draft.sections.change) lines.push(summaryField('  Changement : ', member.draft.sections.change))
  return lines
}

type CoverageCriterion = FramingProposal['input']['coverage'][number]['assignments'][number]['criterion']

function criterionDescription(
  criterion: CoverageCriterion,
  member: Member | undefined,
  plan: Plan | undefined,
): string {
  const id =
    criterion.kind === 'existing'
      ? criterion.id
      : (plan?.allocation?.assignments.find((item) => item.draftKey === criterion.draftKey)?.id ?? criterion.draftKey)
  const items = member?.kind === 'uw' ? [...member.draft.criteria, ...member.draft.invariants] : []
  const item = items.find((entry) =>
    criterion.kind === 'existing'
      ? entry.kind === 'existing' && entry.id === criterion.id
      : entry.kind === 'new' && entry.draftKey === criterion.draftKey,
  )
  return `${id}${item ? ` — ${item.statement}` : ''}`
}

function coverageEffects(proposal: FramingProposal, names: Map<string, string>): string[] {
  const lines: string[] = []
  for (const coverage of proposal.input.coverage) {
    const member = proposal.input.members.find((item) => item.slot.key === coverage.parent)
    const plan = proposal.members.find((item) => item.key === coverage.parent)
    for (const assignment of coverage.assignments) {
      const criterion = criterionDescription(assignment.criterion, member, plan)
      const children = assignment.children.map((child) => names.get(child) ?? child).join(', ')
      lines.push(
        summaryField('Couverture : ', `${names.get(coverage.parent) ?? coverage.parent} — ${criterion} → ${children}`),
      )
    }
  }
  for (const foundation of proposal.input.foundations)
    lines.push(
      summaryField(
        'Fondation : ',
        `${names.get(foundation.parent) ?? foundation.parent} → ${names.get(foundation.child) ?? foundation.child}`,
      ),
    )
  return lines
}

export function framingSummary(proposal: FramingProposal): string[] {
  const lines = ['Proposition à examiner', 'Appliquer les créations, modifications et relations de ce cadrage ?']
  const names = new Map(
    proposal.input.members.map((member) => [
      member.slot.key,
      `${member.title} (${member.slot.kind === 'new' ? member.slot.repository : `${member.slot.uw.repository} : ${member.slot.uw.target}`})`,
    ]),
  )
  for (const member of proposal.input.members) {
    const plan = proposal.members.find((item) => item.key === member.slot.key)
    lines.push(...memberEffects(member, plan))
    if (member.kind === 'uw') lines.push(...accountingEffects(proposal, member, plan))
  }
  for (const edge of proposal.input.edges) {
    if (edge.kind === 'parent-child')
      lines.push(
        summaryField(
          'Relation parent → enfant : ',
          `${names.get(edge.parent) ?? edge.parent} → ${names.get(edge.child) ?? edge.child}`,
        ),
      )
    else
      lines.push(
        summaryField(
          'Dépendance : ',
          `${names.get(edge.dependent) ?? edge.dependent} bloqué par ${names.get(edge.blocker) ?? edge.blocker}`,
        ),
      )
  }
  lines.push(...coverageEffects(proposal, names))
  for (const member of proposal.input.members) lines.push(...memberContents(member))
  lines.push('Les effets peuvent être partiels ; aucun retour arrière automatique.')
  return lines
}
