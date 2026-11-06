import { parseIssueSpecBody, rawSource } from '../../../../contracts.ts'
import { buildRecord } from '../../../../engine/record-construction.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import type { childNode } from './epic-driver-nodes.ts'
import { framedRecords, ME, serveComments, serveEpic, strictSpecBody } from './epic-driver-records.ts'
import { git, sandboxOf } from './epic-driver-sandbox.ts'

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

/** Real parent/child mandate and PR binding for a child admitted to this Epic. */
export function serveBoundEpic(
  child: { number: number; body: string },
  pr: number,
  branch: string,
  allocated = false,
  siblings: readonly ReturnType<typeof childNode>[] = [],
): void {
  const fixtures = roxabiWorkflowFixtures()
  const parentScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: `o/r#${child.number}` }
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, child.body)
  const seed = fixtures.epicMandate(
    parentScope,
    [
      { scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' },
      ...siblings.map((sibling) => {
        const scope = { repository: 'o/r', target: `o/r#${sibling.number}` }
        const childSpec = snapshot(scope, sibling.body)
        return { scope, snapshot: childSpec, specVersion: childSpec.spec.version, tier: 'S' as const }
      }),
    ],
    { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
  )
  const prepared = buildRecord({
    ...seed,
    payload: { ...seed.payload, lineageHead: git(sandboxOf().epic, 'rev-parse', 'refs/remotes/origin/main') },
  })
  if (!prepared.ok || prepared.value.kind !== 'mandate') throw new Error('Invalid Parent mandate fixture')
  const parent = prepared.value
  const mandate = fixtures.featureMandate(childScope, {
    body: child.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(parent),
    inheritedOwnSpecRefs: [
      { uw: parentScope, version: parent.payload.ownSpec.version, sourceAccepted: fixtures.mandateRef(parent) },
    ],
    branch,
    runId: 'run00002',
    run: 'run00002',
  })
  const parentHistory = fixtures.historyFrom([parent])
  const childHistory = fixtures.historyFrom([mandate], ME, ME, [parentHistory])
  const binding = fixtures.workflowBinding({ repository: 'o/r', target: `o/r#${pr}` }, mandate, branch, 'main')
  serveEpic(
    [
      {
        ...child,
        fixtureComments: fixtures.framedBodies([mandate], ME, [parentHistory]).map((body) => ({ body, author: ME })),
      },
      ...siblings,
    ],
    framedRecords(1, allocated ? [fixtures.identityAllocation(parentScope), parent] : [parent]),
    { mandate: false },
  )
  serveComments(
    pr,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
}
