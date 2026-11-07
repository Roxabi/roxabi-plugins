import type { z } from 'zod'
import { canonicalValueDigest } from './canonical-value.ts'
import { WAYFINDER_LABELS } from './uw-graph.ts'
import type { AssessmentOperandsValue, ProposedAssessmentState } from './workflow-action-operands.ts'
import { coverageCriterionName, coverageProposedChildName, coverageSpecName } from './workflow-coverage-names.ts'

const scopeKey = (scope: { repository: string; target: string }) => `${scope.repository}\0${scope.target}`
const subjectKey = (
  subject: NonNullable<ProposedAssessmentState['coverage']>['assignments'][number]['children'][number],
) => ('kind' in subject ? `slot\0${subject.operationId}` : `scope\0${scopeKey(subject)}`)

function refineChildren(value: AssessmentOperandsValue, context: z.RefinementCtx): Set<string> {
  const proposed = value.proposed
  const childKeys = new Set<string>()
  for (const [index, child] of proposed.children.entries()) {
    const key = 'kind' in child ? subjectKey(child) : subjectKey(child.scope)
    if (childKeys.has(key))
      context.addIssue({
        code: 'custom',
        path: ['proposed', 'children', index],
        message: 'proposed child is repeated',
      })
    childKeys.add(key)
    if (
      'kind' in child &&
      (child.operationId !== child.plan.operationId || canonicalValueDigest(child.plan) !== child.planDigest)
    )
      context.addIssue({
        code: 'custom',
        path: ['proposed', 'children', index],
        message: 'created slot must bind the exact plan operation and digest',
      })
  }
  return childKeys
}

function refineAttachmentsAndSources(value: AssessmentOperandsValue, context: z.RefinementCtx): void {
  const proposed = value.proposed
  const attachedKeys = value.attachedChildren.map((child) => scopeKey(child.scope))
  const wayfinderKeys = value.attachedWayfinders.map(({ issue }) =>
    scopeKey({ repository: issue.repository, target: `${issue.repository}#${issue.number}` }),
  )
  const allAttachments = [...attachedKeys, ...wayfinderKeys]
  for (const [index, wayfinder] of value.attachedWayfinders.entries()) {
    const known = wayfinder.labels.some((label) => WAYFINDER_LABELS.some((candidate) => candidate === label))
    const unknown = wayfinder.labels.some(
      (label) => label.startsWith('wayfinder:') && !WAYFINDER_LABELS.some((candidate) => candidate === label),
    )
    if (!known || unknown)
      context.addIssue({
        code: 'custom',
        path: ['attachedWayfinders', index],
        message: 'attachment must have known, unambiguous wayfinder labels',
      })
  }
  const plannedAttachments = proposed.children.flatMap((child) =>
    'kind' in child
      ? child.plan.writes.relations.addChildren.map((ref) =>
          scopeKey({ repository: ref.repository, target: `${ref.repository}#${ref.number}` }),
        )
      : [],
  )
  if (
    new Set(allAttachments).size !== allAttachments.length ||
    new Set(plannedAttachments).size !== plannedAttachments.length ||
    allAttachments.length !== plannedAttachments.length ||
    allAttachments.some((key) => !plannedAttachments.includes(key))
  )
    context.addIssue({
      code: 'custom',
      path: ['attachedChildren'],
      message: 'attached UWs and wayfinders must exactly match the sealed creation plan',
    })
  const expectedOwn = new Set([
    ...value.accepted.children.map((child) => scopeKey(child.scope)),
    ...proposed.children.flatMap((child) => ('kind' in child ? [] : [scopeKey(child.scope)])),
    ...attachedKeys,
  ])
  const seenOwn = new Set<string>()
  for (const [index, source] of value.childOwnSources.entries()) {
    const key = scopeKey(source.uw)
    if (!expectedOwn.has(key) || seenOwn.has(key) || (source.own !== null && scopeKey(source.own.uw) !== key))
      context.addIssue({
        code: 'custom',
        path: ['childOwnSources', index],
        message: 'child own source must uniquely name an exact existing child',
      })
    seenOwn.add(key)
  }
  if (seenOwn.size !== expectedOwn.size)
    context.addIssue({
      code: 'custom',
      path: ['childOwnSources'],
      message: 'every existing child requires one captured own-source declaration',
    })
}

function refineCoverageCompleteness(
  value: AssessmentOperandsValue,
  context: z.RefinementCtx,
  sets: {
    criteria: ReadonlySet<string>
    childKeys: ReadonlySet<string>
    rows: ReadonlySet<string>
    covered: ReadonlySet<string>
  },
): void {
  const missingCriteria = [...sets.criteria].filter((criterion) => !sets.rows.has(criterion))
  const missingChildren = value.proposed.children.filter(
    (child) => !sets.covered.has('kind' in child ? subjectKey(child) : subjectKey(child.scope)),
  )
  if (
    sets.rows.size !== sets.criteria.size ||
    sets.covered.size !== sets.childKeys.size ||
    missingCriteria.length > 0 ||
    missingChildren.length > 0
  )
    context.addIssue({
      code: 'custom',
      path: ['proposed', 'coverage'],
      message: `coverage must include every criterion and child of ${coverageSpecName(value.accepted.ref.uw, value.proposed.snapshot.spec.version)}; missing criteria: [${missingCriteria.map((criterion) => coverageCriterionName(value.accepted.ref.uw, value.proposed.snapshot.spec.version, criterion)).join(', ')}]; missing children: [${missingChildren.map((child) => coverageProposedChildName('kind' in child ? child : child.scope, value.proposed.children)).join(', ')}]`,
    })
}

function refineCoverageAssignments(
  value: AssessmentOperandsValue,
  coverage: NonNullable<ProposedAssessmentState['coverage']>,
  context: z.RefinementCtx,
  childKeys: Set<string>,
): void {
  const criteria = new Set(value.proposed.snapshot.spec.criteria.map((criterion) => criterion.id))
  const rows = new Set<string>()
  const covered = new Set<string>()
  for (const [index, row] of coverage.assignments.entries()) {
    if (!criteria.has(row.criterion) || rows.has(row.criterion))
      context.addIssue({
        code: 'custom',
        path: ['proposed', 'coverage', 'assignments', index],
        message: `criterion is unknown or repeated: ${coverageCriterionName(value.accepted.ref.uw, value.proposed.snapshot.spec.version, row.criterion)}`,
      })
    rows.add(row.criterion)
    const perRow = new Set<string>()
    for (const child of row.children) {
      const key = subjectKey(child)
      if (!childKeys.has(key) || perRow.has(key))
        context.addIssue({
          code: 'custom',
          path: ['proposed', 'coverage', 'assignments', index],
          message: `coverage child is uncommitted or repeated for ${coverageSpecName(value.accepted.ref.uw, value.proposed.snapshot.spec.version)}: ${coverageProposedChildName(child, value.proposed.children)}`,
        })
      perRow.add(key)
      covered.add(key)
    }
  }
  refineCoverageCompleteness(value, context, { criteria, childKeys, rows, covered })
}

function refineCoverage(value: AssessmentOperandsValue, context: z.RefinementCtx, childKeys: Set<string>): void {
  const proposed = value.proposed
  if (proposed.children.length === 0) {
    if (proposed.coverage !== null)
      context.addIssue({
        code: 'custom',
        path: ['proposed', 'coverage'],
        message: `leaf ${coverageSpecName(value.accepted.ref.uw, proposed.snapshot.spec.version)} has no parent coverage`,
      })
  } else if (proposed.coverage === null) {
    context.addIssue({
      code: 'custom',
      path: ['proposed', 'coverage'],
      message: `parent coverage is required for ${coverageSpecName(value.accepted.ref.uw, proposed.snapshot.spec.version)}: ${proposed.children.map((child) => coverageProposedChildName('kind' in child ? child : child.scope, proposed.children)).join(', ')}`,
    })
  } else {
    if (
      scopeKey(proposed.coverage.parent.uw) !== scopeKey(value.accepted.ref.uw) ||
      proposed.coverage.parent.version !== proposed.snapshot.spec.version
    )
      context.addIssue({
        code: 'custom',
        path: ['proposed', 'coverage', 'parent'],
        message: `coverage parent ${coverageSpecName(proposed.coverage.parent.uw, proposed.coverage.parent.version)} must bind proposed parent ${coverageSpecName(value.accepted.ref.uw, proposed.snapshot.spec.version)}`,
      })
    refineCoverageAssignments(value, proposed.coverage, context, childKeys)
  }
}

export function refineAssessmentProposal(value: AssessmentOperandsValue, context: z.RefinementCtx): void {
  const childKeys = refineChildren(value, context)
  refineAttachmentsAndSources(value, context)
  refineCoverage(value, context, childKeys)
}
