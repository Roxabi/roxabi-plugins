import { parseIssueSpecBody, rawSource } from '../../../../contracts.ts'
import { buildRecord } from '../../../../engine/record-construction.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { A, B, C, EPIC, RUN_A } from './goal-scenario-domain.ts'
import { readSim, sandboxInitialParentHead } from './goal-scenario-sandbox.ts'

const { epicMandate, featureMandate, mandateRef, ownSpecFromSnapshot } = roxabiWorkflowFixtures()

export function currentSpec(number: number) {
  const issue = readSim().issues[String(number)]
  if (!issue) throw new Error(`missing issue #${number}`)
  const scope = { repository: 'acme/app', target: `acme/app#${number}` }
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, issue.body, '2026-01-01T00:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec #${number} is ${parsed.status}`)
  return { scope, snapshot: parsed.snapshot }
}

export function epicRecord() {
  const current = currentSpec(EPIC)
  const children = [A, B, C].map((number) => {
    const child = currentSpec(number)
    return {
      scope: child.scope,
      specVersion: child.snapshot.spec.version,
      snapshot: child.snapshot,
      tier: 'F-lite' as const,
    }
  })
  const seed = epicMandate(current.scope, children, {
    runId: RUN_A,
    run: RUN_A,
    body: current.snapshot.raw.body,
    ownSpec: ownSpecFromSnapshot(current.scope, current.snapshot),
    tier: 'F-lite',
  })
  const lineageHead = sandboxInitialParentHead()
  const parent = buildRecord({ ...seed, payload: { ...seed.payload, branch: null, lineageHead } })
  if (!parent.ok || parent.value.kind !== 'mandate') throw new Error('Invalid Goal parent mandate')
  return parent.value
}

export function childMandate(number: number, branch: string, id: string) {
  const epic = epicRecord()
  const current = currentSpec(number)
  return featureMandate(current.scope, {
    recordId: `mandate-feature-${id}`,
    operationId: `op-mandate-feature-${id}`,
    runId: RUN_A,
    run: RUN_A,
    body: current.snapshot.raw.body,
    branch,
    base: 'main',
    lineageHead: null,
    parent: mandateRef(epic),
    inheritedOwnSpecRefs: [
      {
        uw: { repository: epic.repository, target: epic.target },
        version: epic.payload.ownSpec.version,
        sourceAccepted: {
          scope: { repository: epic.repository, target: epic.target },
          recordId: epic.recordId,
          kind: 'mandate',
        },
      },
    ],
    ownSpec: ownSpecFromSnapshot(current.scope, current.snapshot),
    tier: 'F-lite',
  })
}
