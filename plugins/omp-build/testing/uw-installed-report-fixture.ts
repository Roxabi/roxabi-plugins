import { assessCauseDispositions, buildRecord } from '../dist/contracts.js'
import { fixtureHostReviewClassCatalogues } from './host-catalogue-fixture.ts'
import { acceptedPullRequestReviewGraph } from './record-graphs.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
export function reportFixture(number: number, sourceNumber: number) {
  const f = roxabiWorkflowFixtures()
  const scope = { repository: 'acme/app', target: `acme/app#${number}` }
  const source = { repository: 'acme/app', target: `acme/app#${sourceNumber}` }
  const mandate = f.fixOnlyMandate(scope, { recordId: `mandate-${number}`, operationId: `mandate-op-${number}` })
  const binding = f.workflowBinding(source, mandate, `fix/${number}-save`, 'main')
  const graph = acceptedPullRequestReviewGraph({ mandate, binding, prefix: `report-${number}`, label: 'suggestion' })
  if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('accepted specification required')
  const assessment = assessCauseDispositions({
    context: { original: scope, effective: graph.inputs.manifest.spec.effective },
    source: { kind: 'decision', decision: graph.decision },
    histories: [f.historyFrom([mandate]), graph.history],
    catalogues: fixtureHostReviewClassCatalogues(),
    adjudications: [],
  })
  if (!assessment.ok) throw new Error(`report assessment refused ${JSON.stringify(assessment.diagnostics)}`)
  const payload = assessment.value.outcomes.find(
    (entry) => entry.outcome.state === 'final' && entry.outcome.disposition === 'report',
  )
  if (!payload) throw new Error('expected authenticated report')
  const report = buildRecord({
    version: 1,
    ...scope,
    recordId: `report-${number}`,
    runId: 'run',
    operationId: `report-op-${number}`,
    kind: 'cause-disposition',
    payload,
  })
  if (!report.ok) throw new Error('report record invalid')
  const sourceRecords = graph.history.operations.flatMap((item) => (item.record === null ? [] : [item.record]))
  return { mandate, report: report.value, sourceRecords }
}
export function subtreeGraph(args: string[]): string {
  const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
  if (number !== 42 && number !== 43) throw new Error(`outside subtree graph read ${number}`)
  const node = (n: number) => ({ number: n, repository: { nameWithOwner: 'acme/app' } })
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number,
          title: `Issue ${number}`,
          body: '',
          updatedAt: '2026-10-27T12:00:00Z',
          state: 'OPEN',
          stateReason: null,
          repository: { nameWithOwner: 'acme/app' },
          parent: node(number === 42 ? 40 : 42),
          labels: page([]),
          subIssues: page(number === 42 ? [node(43)] : []),
          blockedBy: page([]),
        },
      },
    },
  })
}
