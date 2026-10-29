import type { CriterionDeclaration, CriterionEvidence } from './criterion-evidence-schema.ts'

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = ordered(source[key])
    return sorted
  }
  return value
}

function sameDeclaration(left: CriterionDeclaration, right: CriterionDeclaration): boolean {
  return JSON.stringify(ordered(left)) === JSON.stringify(ordered(right))
}

function evidenceConflict(prior: CriterionEvidence, value: CriterionEvidence): boolean {
  return JSON.stringify(ordered(prior)) !== JSON.stringify(ordered(value))
}

function appendEvidence(evidence: CriterionEvidence[], value: CriterionEvidence): boolean {
  const prior = evidence.find((existing) => existing.id === value.id)
  if (prior !== undefined && evidenceConflict(prior, value)) return false
  if (prior === undefined) evidence.push(value)
  return true
}

function mergedEvidence(group: readonly CriterionDeclaration[]): CriterionDeclaration | null {
  const first = group[0]
  if (first === undefined || first.verification !== 'evidence') return null
  if (!group.every((item) => item.verification === 'evidence')) return null
  const evidence = [...first.evidence]
  for (const item of group.slice(1)) {
    if (item.verification !== 'evidence') return null
    if (!item.evidence.every((value) => appendEvidence(evidence, value))) return null
  }
  return { ...first, evidence }
}

function projectGroup(group: readonly CriterionDeclaration[]): CriterionDeclaration[] {
  const first = group[0]
  if (first === undefined) return []
  if (group.length === 1 || group.every((item) => sameDeclaration(item, first))) return [first]
  const merged = mergedEvidence(group)
  return merged === null ? group.slice() : [merged]
}

export function projectAdditiveDeclarations(declarations: readonly CriterionDeclaration[]): CriterionDeclaration[] {
  const grouped = new Map<string, CriterionDeclaration[]>()
  for (const declaration of declarations) {
    const list = grouped.get(declaration.target.id) ?? []
    list.push(declaration)
    grouped.set(declaration.target.id, list)
  }
  return [...grouped.values()].flatMap(projectGroup)
}
