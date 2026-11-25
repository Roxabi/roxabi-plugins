import type { FramingProposal } from '../engine/uw-framing-receipt-schema.ts'
import { accountingDetails } from './omp-operator-confirmation-accounting.ts'
import { PARTIAL, summaryField } from './omp-operator-confirmation-field.ts'

type Member = FramingProposal['input']['members'][number]
type Plan = FramingProposal['members'][number]

function identityDetails(plan: Plan | undefined): string[] {
  if (!plan?.allocation) return []
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
    lines.push(summaryField('  Nouvelle identité : ', assignment.id))
  }
  for (const item of after) {
    const previous = before.find((entry) => entry.id === item.id)
    if (previous && previous.statement !== item.statement)
      lines.push(summaryField('  Identité reformulée, avant : ', `${item.id} — ${previous.statement}`))
  }
  return lines
}

function memberScope(member: Member): string {
  const slot = member.slot
  return slot.kind === 'new' ? slot.repository : `${slot.uw.repository} : ${slot.uw.target}`
}

function existingMemberEffects(
  kind: Member['kind'],
  observed: Extract<Member['slot'], { kind: 'existing' }>['observed'],
): string[] {
  const lines = [
    kind === 'uw'
      ? '  Effet : remplacer le titre et le corps par le titre et la spécification proposés'
      : '  Effet : remplacer le titre et le corps par le titre et le contenu du repère proposés',
  ]
  if (observed.nativeParent) lines.push(summaryField('  Parent actuel : ', observed.nativeParent.target))
  if (observed.children.length)
    lines.push(summaryField('  Enfants actuels : ', observed.children.map((child) => child.target).join(', ')))
  if (observed.blockers.length)
    lines.push(summaryField('  Blocages actuels : ', observed.blockers.map((blocker) => blocker.target).join(', ')))
  return lines
}

function memberEffects(member: Member, plan: Plan | undefined): string[] {
  const action = member.slot.kind === 'new' ? 'Créer' : 'Modifier'
  const lines = [summaryField(`${action} : `, member.title), summaryField('  Périmètre : ', memberScope(member))]
  if (member.slot.kind === 'existing') lines.push(...existingMemberEffects(member.kind, member.slot.observed))
  if (member.kind === 'wayfinder') {
    if (member.slot.kind === 'new') lines.push('  Effet : publier le repère')
    lines.push(summaryField('  Label de repère cible : ', member.label))
    return lines
  }
  if (member.slot.kind === 'new') lines.push('  Effet : publier la spécification proposée')
  if (plan?.tier) lines.push(summaryField('  Niveau proposé : ', plan.tier))
  const allocated = plan?.allocation?.assignments.length ?? 0
  const retired = plan?.allocation?.retirements.length ?? 0
  if (allocated || retired) lines.push(`  Identités : ${allocated} à attribuer, ${retired} à retirer`)
  if (member.labels.add.length) lines.push(summaryField('  Labels à ajouter : ', member.labels.add.join(', ')))
  if (member.labels.remove.length) lines.push(summaryField('  Labels à retirer : ', member.labels.remove.join(', ')))
  return lines
}

function memberContents(member: Member, plan: Plan | undefined): string[] {
  if (member.kind === 'wayfinder') return [summaryField('Contenu du repère : ', member.body)]
  const spec = plan?.allocation?.spec ?? member.draft
  const lines: string[] = []
  if (spec.criteria.length) lines.push('Critères finaux')
  for (const item of spec.criteria) {
    const id = 'id' in item ? item.id : item.draftKey
    lines.push(summaryField('  ', `${id} — ${item.statement}`))
  }
  if (spec.invariants.length) lines.push('Invariants finaux')
  for (const item of spec.invariants) {
    const id = 'id' in item ? item.id : item.draftKey
    lines.push(summaryField('  ', `${id} — ${item.statement}`))
  }
  for (const item of spec.exclusions) lines.push(summaryField('Exclusion : ', item))
  for (const item of spec.openQuestions) lines.push(summaryField('Question ouverte : ', item))
  if (spec.sections.origin) lines.push(summaryField('Origine : ', spec.sections.origin))
  if (spec.sections.context) lines.push(summaryField('Contexte : ', spec.sections.context))
  if (spec.sections.change) lines.push(summaryField('Changement : ', spec.sections.change))
  return lines
}

type CoverageCriterion = FramingProposal['input']['coverage'][number]['assignments'][number]['criterion']

function criterionId(criterion: CoverageCriterion, plan: Plan | undefined): string {
  if (criterion.kind === 'existing') return criterion.id
  return plan?.allocation?.assignments.find((item) => item.draftKey === criterion.draftKey)?.id ?? criterion.draftKey
}

function coverageEffects(
  proposal: FramingProposal,
  names: ReadonlyMap<string, string>,
  plans: ReadonlyMap<string, Plan>,
): string[] {
  const lines: string[] = []
  for (const coverage of proposal.input.coverage) {
    const plan = plans.get(coverage.parent)
    for (const assignment of coverage.assignments) {
      const criterion = criterionId(assignment.criterion, plan)
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
  const lines = [
    'Proposition à examiner',
    'Appliquer les créations, modifications et relations de ce cadrage ?',
    'Tickets et effets',
  ]
  const names = new Map(
    proposal.input.members.map((member) => [member.slot.key, `${member.title} (${memberScope(member)})`]),
  )
  const plans = new Map(proposal.members.map((plan) => [plan.key, plan]))
  for (const member of proposal.input.members) lines.push(...memberEffects(member, plans.get(member.slot.key)))
  if (proposal.input.edges.length || proposal.input.coverage.length || proposal.input.foundations.length)
    lines.push('', 'Relations et couverture')
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
  lines.push(...coverageEffects(proposal, names, plans))
  for (const member of proposal.input.members) {
    const contents = memberContents(member, plans.get(member.slot.key))
    if (contents.length) lines.push('', summaryField('Contenu final : ', member.title), ...contents)
  }
  lines.push('', PARTIAL)
  return lines
}

export function framingDetails(proposal: FramingProposal): string[] {
  const plans = new Map(proposal.members.map((plan) => [plan.key, plan]))
  const lines: string[] = []
  for (const member of proposal.input.members) {
    if (member.kind !== 'uw') continue
    const plan = plans.get(member.slot.key)
    const identities = identityDetails(plan)
    const accounting = accountingDetails(proposal, member, plan)
    if (!identities.length && !accounting.length) continue
    lines.push('', summaryField('Vérification du cadrage : ', member.title))
    if (identities.length) lines.push('Identités (textes finaux dans le résumé)', ...identities)
    lines.push(...accounting)
  }
  return lines
}
