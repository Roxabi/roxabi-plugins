import { renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  abandon,
  branch,
  child,
  fixtureOwnSpec,
  type MutateWorld,
  proposal,
  scope,
  selectionWorld,
  sibling,
  specFor,
} from './uw-successor-selection-support.ts'

const fixtures = roxabiWorkflowFixtures()
const parentCwd = '/fixture-worktrees/app/parents/acme-41'

function parentFraming() {
  const own = specFor(scope, 'Coordinate the bounded child output.')
  const delegated = specFor(child, 'Deliver the bounded child output.')
  const grant = {
    scope: child,
    specVersion: delegated.snapshot.spec.version,
    snapshot: delegated.snapshot,
    tier: 'S' as const,
  }
  const parent = fixtures.epicMandate(scope, [grant], {
    recordId: 'parent-original',
    operationId: 'parent-operation',
    ownSpec: own.ownSpec,
    tier: 'S',
  })
  const parentRef = { scope, recordId: parent.recordId, kind: 'mandate' as const }
  const managed = () =>
    fixtures.featureMandate(child, {
      recordId: 'child-original',
      operationId: 'child-operation',
      ownSpec: delegated.ownSpec,
      branch,
      parent: parentRef,
      inheritedOwnSpecRefs: [{ uw: scope, version: parent.payload.ownSpec.version, sourceAccepted: parentRef }],
    })
  return {
    parent,
    managed,
    records: [own.allocation, parent, delegated.allocation],
    issues: {
      41: { title: 'Parent succession', body: own.body, labels: ['size:S'] },
      42: { title: 'Bounded child', body: delegated.body, labels: ['size:S'], parent: 41 },
    },
  }
}

export async function abandonedParent(
  childState: 'unmanaged' | 'active' | 'abandoned' = 'unmanaged',
  mutate?: MutateWorld,
) {
  const frame = parentFraming()
  const abandonment = abandon(frame.parent)
  const records: CanonicalRecord[] = [...frame.records, abandonment]
  if (childState !== 'unmanaged') {
    const managed = frame.managed()
    records.push(managed)
    if (childState === 'abandoned') records.push(abandon(managed))
  }
  const world = await selectionWorld({
    uw: scope,
    issues: frame.issues,
    records,
    original: frame.parent,
    abandonment,
    cwd: parentCwd,
    mutate,
  })
  return Object.assign(world, { childMandate: frame.managed() })
}

export async function abandonedNestedLeaf(mutate?: MutateWorld) {
  const frame = parentFraming()
  const original = frame.managed()
  const abandonment = abandon(original)
  return selectionWorld({
    uw: child,
    issues: frame.issues,
    records: [...frame.records, original, abandonment],
    original,
    abandonment,
    cwd: parentCwd,
    mutate,
  })
}

export async function abandonedNestedSiblings(siblingState: 'active' | 'abandoned') {
  const frame = parentFraming()
  const delegated = specFor(sibling, 'Deliver the independently bounded sibling output.')
  const parent = fixtures.epicMandate(
    scope,
    [
      ...frame.parent.payload.children,
      { scope: sibling, specVersion: delegated.snapshot.spec.version, snapshot: delegated.snapshot, tier: 'S' },
    ],
    {
      recordId: frame.parent.recordId,
      operationId: frame.parent.operationId,
      ownSpec: fixtureOwnSpec(frame.parent.payload.ownSpec),
      tier: 'S',
    },
  )
  const original = frame.managed()
  const abandonment = abandon(original)
  const siblingMandate = fixtures.featureMandate(sibling, {
    recordId: 'sibling-original',
    operationId: 'sibling-operation',
    ownSpec: delegated.ownSpec,
    branch: 'feature/sibling',
    parent: original.payload.parent,
    inheritedOwnSpecRefs: original.payload.inheritedOwnSpecRefs,
  })
  const siblingAbandonment = abandon(siblingMandate)
  const world = await selectionWorld({
    uw: child,
    issues: {
      ...frame.issues,
      43: { title: 'Independent sibling', body: delegated.body, labels: ['size:S'], parent: 41 },
    },
    records: [
      ...frame.records.map((record) => (record === frame.parent ? parent : record)),
      delegated.allocation,
      original,
      abandonment,
      siblingMandate,
      ...(siblingState === 'abandoned' ? [siblingAbandonment] : []),
    ],
    original,
    abandonment,
    cwd: parentCwd,
  })
  return Object.assign(world, { siblingAbandonment })
}

export const reframedStatement = 'Coordinate the retained child and expose its reviewed delivery outcome.'
export function reframedParent() {
  return abandonedParent('unmanaged', ({ native }) => {
    const issue = native.issues.get(41)
    if (!issue) throw new Error('missing Parent issue')
    issue.body = renderIssueSpecBody(proposal(reframedStatement), { complexity: 2 })
  })
}

export async function abandonedNestedParent() {
  const frame = parentFraming()
  const base = frame.managed()
  const delegated = specFor(sibling, 'Deliver the nested Parent delegated output.')
  const original = fixtures.epicMandate(
    child,
    [{ scope: sibling, specVersion: delegated.snapshot.spec.version, snapshot: delegated.snapshot, tier: 'S' }],
    {
      recordId: base.recordId,
      operationId: base.operationId,
      ownSpec: fixtureOwnSpec(base.payload.ownSpec),
      tier: base.payload.tier,
      inheritedOwnSpecRefs: base.payload.inheritedOwnSpecRefs,
    },
  )
  // The generic epic fixture is root-only; encode this Parent's real ancestor explicitly.
  original.payload.parent = base.payload.parent
  const abandonment = abandon(original)
  return selectionWorld({
    uw: child,
    issues: {
      ...frame.issues,
      43: { title: 'Nested delegated output', body: delegated.body, labels: ['size:S'], parent: 42 },
    },
    records: [...frame.records, delegated.allocation, original, abandonment],
    original,
    abandonment,
    cwd: parentCwd,
  })
}

export async function revokedNestedLeaf() {
  const frame = parentFraming()
  const original = frame.managed()
  const abandonment = abandon(frame.parent)
  return selectionWorld({
    uw: child,
    issues: frame.issues,
    records: [...frame.records, original, abandonment],
    original,
    abandonment,
    cwd: parentCwd,
  })
}
