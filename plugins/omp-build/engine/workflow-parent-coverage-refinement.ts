import type { z } from 'zod'
import { coverageAcceptedChildName, coverageCriterionName, coverageSpecName } from './workflow-coverage-names.ts'
import type { AcceptedChildCommitment, ParentCoverage } from './workflow-mandate-schema.ts'

type CoverageInput = {
  own: {
    uw: { repository: string; target: string }
    version: string
    snapshot: { spec: { criteria: readonly { id: string }[] } }
  }
  children: readonly AcceptedChildCommitment[]
}

export function refinePopulatedParentCoverage(
  value: CoverageInput,
  coverage: ParentCoverage,
  context: z.RefinementCtx,
): void {
  const parent = coverageSpecName(value.own.uw, value.own.version)
  if (
    coverage.parent.uw.repository !== value.own.uw.repository ||
    coverage.parent.uw.target !== value.own.uw.target ||
    coverage.parent.version !== value.own.version
  )
    context.addIssue({
      code: 'custom',
      path: ['coverage', 'parent'],
      message: `coverage parent ${coverageSpecName(coverage.parent.uw, coverage.parent.version)} must bind accepted parent ${parent}`,
    })
  const criteria = new Set(value.own.snapshot.spec.criteria.map((criterion) => criterion.id))
  const children = new Set(value.children.map((child) => `${child.scope.repository}\0${child.scope.target}`))
  const assigned = new Set<string>()
  const covered = new Set<string>()
  for (const [index, assignment] of coverage.assignments.entries()) {
    if (!criteria.has(assignment.criterion) || assigned.has(assignment.criterion))
      context.addIssue({
        code: 'custom',
        path: ['coverage', 'assignments', index, 'criterion'],
        message: `coverage criterion is unknown or repeated: ${coverageCriterionName(value.own.uw, value.own.version, assignment.criterion)}`,
      })
    assigned.add(assignment.criterion)
    const row = new Set<string>()
    for (const child of assignment.children) {
      const key = `${child.repository}\0${child.target}`
      if (!children.has(key) || row.has(key))
        context.addIssue({
          code: 'custom',
          path: ['coverage', 'assignments', index, 'children'],
          message: `coverage child is uncommitted or repeated for ${parent}: ${coverageAcceptedChildName(child, value.children)}`,
        })
      row.add(key)
      covered.add(key)
    }
  }
  const missingCriteria = [...criteria].filter((criterion) => !assigned.has(criterion))
  if (missingCriteria.length > 0)
    context.addIssue({
      code: 'custom',
      path: ['coverage', 'assignments'],
      message: `every parent criterion requires coverage: ${missingCriteria.map((criterion) => coverageCriterionName(value.own.uw, value.own.version, criterion)).join(', ')}`,
    })
  const missingChildren = value.children.filter(
    (child) => !covered.has(`${child.scope.repository}\0${child.scope.target}`),
  )
  if (missingChildren.length > 0)
    context.addIssue({
      code: 'custom',
      path: ['coverage', 'assignments'],
      message: `every accepted child requires coverage for ${parent}: ${missingChildren.map((child) => coverageSpecName(child.scope, child.specVersion)).join(', ')}`,
    })
}
