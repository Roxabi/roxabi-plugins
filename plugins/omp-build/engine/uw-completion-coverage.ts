import type { Scope } from './record-values.ts'
import { sameScope, scopeKey } from './uw-graph.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { coverageAcceptedChildName, coverageCriterionName, coverageSpecName } from './workflow-coverage-names.ts'

function invalidChildren(
  children: readonly Scope[],
  spec: AcceptedOwnSpec,
  childKeys: ReadonlySet<string>,
  covered: Set<string>,
): string | null {
  const row = new Set<string>()
  for (const child of children) {
    const key = scopeKey(child)
    if (!childKeys.has(key) || row.has(key))
      return `Coverage names an unknown or repeated child: ${coverageAcceptedChildName(child, spec.children)}`
    row.add(key)
    covered.add(key)
  }
  return null
}

function missingCoverageProblem(
  uw: Scope,
  spec: AcceptedOwnSpec,
  assigned: ReadonlySet<string>,
  covered: ReadonlySet<string>,
): string {
  const criteria = spec.snapshot.spec.criteria.filter((criterion) => !assigned.has(criterion.id))
  const children = spec.children.filter((child) => !covered.has(scopeKey(child.scope)))
  return `Coverage omits obligations of ${coverageSpecName(uw, spec.ref.version)}; criteria: [${criteria.map((criterion) => coverageCriterionName(uw, spec.ref.version, criterion.id)).join(', ')}]; accepted children: [${children.map((child) => coverageSpecName(child.scope, child.specVersion)).join(', ')}]`
}

export function completionCoverageProblem(uw: Scope, spec: AcceptedOwnSpec): string | null {
  const coverage = spec.coverage
  const parent = coverageSpecName(uw, spec.ref.version)
  if (spec.children.length === 0 ? coverage !== null : coverage === null)
    return `Coverage must exactly describe parent ${parent} and accepted children: [${spec.children.map((child) => coverageSpecName(child.scope, child.specVersion)).join(', ')}]`
  if (!coverage) return null
  if (!sameScope(coverage.parent.uw, uw) || coverage.parent.version !== spec.ref.version)
    return `Coverage parent ${coverageSpecName(coverage.parent.uw, coverage.parent.version)} differs from accepted parent ${parent}`
  const criteria = spec.snapshot.spec.criteria.map((criterion) => criterion.id)
  const childKeys = new Set(spec.children.map((child) => scopeKey(child.scope)))
  const assigned = new Set<string>()
  const covered = new Set<string>()
  for (const assignment of coverage.assignments) {
    if (
      !criteria.includes(assignment.criterion) ||
      assigned.has(assignment.criterion) ||
      assignment.children.length === 0
    )
      return `Coverage has an unknown, repeated or empty assignment: ${coverageCriterionName(uw, spec.ref.version, assignment.criterion)}`
    assigned.add(assignment.criterion)
    const childProblem = invalidChildren(assignment.children, spec, childKeys, covered)
    if (childProblem !== null) return childProblem
  }
  if (assigned.size !== criteria.length || covered.size !== childKeys.size)
    return missingCoverageProblem(uw, spec, assigned, covered)
  return null
}
