import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import type { CanonicalRecord } from '../../dist/contracts.js'
import {
  assessCauseDispositions,
  buildRecord,
  causeAdjudicationProposalSchema,
  resolveCauseActionInputs,
} from '../../dist/contracts.js'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { observedComment, operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { fixture } from '../../testing/uw-operations-fixture.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

function reportFixture(number: number, sourceNumber: number) {
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
function subtreeGraph(args: string[]): string {
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

it.each([false, true])(
  'lists only authenticated reports in the selected installed subtree; incomplete=%s',
  async (incomplete) => {
    const root = reportFixture(42, 44)
    const child = reportFixture(43, 45)
    const comments = new Map([
      [42, [root.mandate, root.report]],
      [43, [child.mandate, child.report]],
      [44, root.sourceRecords],
      [45, child.sourceRecords],
    ])
    const reads: number[] = []
    const gh: Gh = async (_cwd, args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'automation'
      if (args[1] === 'graphql') return subtreeGraph(args)
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      const number = Number(/issues\/(\d+)\/comments/.exec(endpoint)?.[1])
      reads.push(number)
      if (incomplete && number === 43) throw new Error('descendant history unavailable')
      const records = comments.get(number)
      if (!records) throw new Error(`unexpected history ${endpoint}`)
      return JSON.stringify(records.map((record, index) => nativeComment(number * 100 + index, wire(record))))
    }
    const operations = await createInstalledUwOperations({
      cwd: '/fixture',
      gh,
      readAuthor: 'automation',
      operator: fixture().ports.operator,
    })
    const result = await operations.listReports({ repository: 'acme/app', target: 'acme/app#42' })
    expect(reads).not.toContain(41)
    if (incomplete) {
      expect(result.ok).toBe(false)
    } else {
      expect(result.ok, JSON.stringify(result)).toBe(true)
      if (!result.ok) throw new Error('listing refused')
      expect(result.value.reports.map((entry) => entry.ref.recordId).sort()).toEqual(['report-42', 'report-43'])
      expect(result.value.reports.every((entry) => entry.promotion === null)).toBe(true)
    }
  },
)

it('lists the final report but not its superseded authenticated pending predecessor', async () => {
  const { graph, context } = authenticatedReview()
  const f = roxabiWorkflowFixtures()
  const mandate = f.featureMandate(context.original, { recordId: 'mandate-42', body: 'Save the selected region' })
  let own = f.historyFrom([mandate])
  const required = <T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly unknown[] }): T => {
    if (!result.ok) throw new Error(`fixture refused: ${JSON.stringify(result.diagnostics)}`)
    return result.value
  }
  const assess = (adjudications: Extract<CanonicalRecord, { kind: 'cause-operation' }>[]) =>
    required(
      assessCauseDispositions({
        context,
        source: { kind: 'decision', decision: graph.decision },
        histories: [own, graph.history],
        adjudications,
      }),
    )
  const initial = assess([]).outcomes.find((item) => item.subject.kind === 'cause')
  if (initial?.outcome.state !== 'pending-blocking' || initial.subject.kind !== 'cause')
    throw new Error('authenticated pending cause required')
  const pending = required(
    buildRecord({
      version: 1,
      ...context.original,
      recordId: 'pending-head',
      runId: 'run',
      operationId: 'write-pending',
      kind: 'cause-disposition',
      payload: initial,
    }),
  )
  if (pending.kind !== 'cause-disposition') throw new Error('pending disposition expected')
  own = {
    ...own,
    operations: [...own.operations, operation(pending, { parts: [observedComment({ author: 'operator' })] })],
  }
  const inputs = required(resolveCauseActionInputs({ decision: graph.decision, history: graph.history, context }))
  const citation = inputs.flatMap((item) => item.manifest.repositoryReferences)[0]
  const rejected = initial.subject.findings[0]
  if (!citation || !rejected) throw new Error('authenticated evidence and finding required')
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const proposal = causeAdjudicationProposalSchema.parse({
    format: 'omp-build-cause-adjudication-proposal/1',
    operationId: 'resolve-pending',
    operation: 'adjudicate-cause',
    uw: context.original,
    pending: { scope: context.original, recordId: pending.recordId, kind: 'cause-disposition' },
    pendingDigest: hash(pending),
    rejectedFindingIds: [rejected.id],
    judgment: null,
    reason: 'The pinned evidence resolves this finding',
    references: [citation],
  })
  const proposalDigest = hash(proposal)
  const adjudication = required(
    buildRecord({
      version: 1,
      ...context.original,
      recordId: 'resolve-operation',
      runId: 'run',
      operationId: 'write-adjudication',
      kind: 'cause-operation',
      payload: {
        format: 'omp-build-cause-operation/1',
        proposal,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: proposal.operationId,
          proposalDigest,
          confirmedAt: '2026-10-27T12:00:00.000Z',
        },
      },
    }),
  )
  if (adjudication.kind !== 'cause-operation') throw new Error('adjudication expected')
  own = {
    ...own,
    operations: [...own.operations, operation(adjudication, { parts: [observedComment({ author: 'operator' })] })],
  }
  const assessed = assess([adjudication])
  const outcome = assessed.outcomes.find((item) => item.previous?.recordId === pending.recordId)
  if (outcome?.outcome.state !== 'final' || outcome.outcome.disposition !== 'report')
    throw new Error(`authenticated report successor expected: ${JSON.stringify(assessed)}`)
  const final = required(
    buildRecord({
      version: 1,
      ...context.original,
      recordId: 'report-head',
      runId: 'run',
      operationId: 'write-report',
      kind: 'cause-disposition',
      payload: outcome,
    }),
  )
  const bodies = [...own.source.comments.map((comment) => comment.body), ...[pending, adjudication, final].map(wire)]
  const gh: Gh = async (_cwd, args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    if (args[1] === 'graphql') {
      const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
      if (number !== 42) throw new Error(`outside subtree graph read ${number}`)
      const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              number,
              title: 'Original',
              body: '',
              updatedAt: '2026-10-27T12:00:00Z',
              state: 'OPEN',
              stateReason: null,
              repository: { nameWithOwner: 'acme/app' },
              parent: null,
              labels: page,
              subIssues: page,
              blockedBy: page,
            },
          },
        },
      })
    }
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    if (!/issues\/42\/comments/.test(endpoint)) throw new Error(`outside subtree history ${endpoint}`)
    return JSON.stringify(bodies.map((body, index) => nativeComment(index + 1, body)))
  }
  const service = await createInstalledUwOperations({
    cwd: '/fixture',
    gh,
    readAuthor: 'automation',
    operator: fixture().ports.operator,
  })
  const listed = await service.listReports(context.original)
  expect(listed.ok, JSON.stringify(listed)).toBe(true)
  if (!listed.ok) throw new Error('report listing refused')
  expect(listed.value.reports.map((entry) => entry.ref.recordId)).toEqual(['report-head'])
})
