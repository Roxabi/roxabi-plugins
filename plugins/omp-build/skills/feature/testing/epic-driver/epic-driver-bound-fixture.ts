import { parseIssueSpecBody, rawSource } from '../../../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { framedRecords, ME, serveComments, serveEpic, strictSpecBody } from './epic-driver-records.ts'

function snapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

/** Real parent/child mandate and PR binding for a child admitted to this Epic. */
export function serveBoundEpic(child: { number: number; body: string }, pr: number, branch: string): void {
  const fixtures = roxabiWorkflowFixtures()
  const parentScope = { repository: 'o/r', target: 'o/r#1' }
  const childScope = { repository: 'o/r', target: `o/r#${child.number}` }
  const parentBody = strictSpecBody('works')
  const childSnapshot = snapshot(childScope, child.body)
  const parent = fixtures.epicMandate(
    parentScope,
    [{ scope: childScope, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
    { body: parentBody, ownSpec: fixtures.ownSpecFromSnapshot(parentScope, snapshot(parentScope, parentBody)) },
  )
  const mandate = fixtures.featureMandate(childScope, {
    body: child.body,
    ownSpec: fixtures.ownSpecFromSnapshot(childScope, childSnapshot),
    parent: fixtures.mandateRef(parent),
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
    ],
    framedRecords(1, [parent]),
    { mandate: false },
  )
  serveComments(
    pr,
    fixtures.framedBodies([binding], ME, [childHistory, parentHistory]).map((body) => ({ body, author: ME })),
  )
}
