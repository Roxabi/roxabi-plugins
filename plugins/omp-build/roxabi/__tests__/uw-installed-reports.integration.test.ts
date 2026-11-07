import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import type { CanonicalRecord } from '../../dist/contracts.js'
import {
  assessCauseDispositions,
  buildRecord,
  causeAdjudicationProposalSchema,
  recordsOf,
  resolveCauseActionInputs,
} from '../../dist/contracts.js'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { authenticatedReview, causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { reportFixture, subtreeGraph } from '../../testing/uw-installed-report-fixture.ts'
import { fixture } from '../../testing/uw-operations-fixture.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

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
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
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
  const decision = recordsOf(graph.history).find(
    (record) => record.kind === 'decision' && record.recordId === graph.decision.recordId,
  )
  if (decision?.kind !== 'decision') throw new Error('authenticated decision required')
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
        capture: synthesisActionCapture(decision, [graph.history]),
        graph: causeFixtureGraph(),
        source: { kind: 'decision', decision },
        histories: [own, graph.history],
        catalogues: fixtureHostReviewClassCatalogues(),
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
  own = encodeCriterionRecords(
    [pending],
    context.original,
    roxabiRecordFixtures().projection,
    'operator',
    [graph.history],
    own,
  ).history
  const inputs = required(resolveCauseActionInputs({ decision, history: graph.history, context }))
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
  own = encodeCriterionRecords(
    [adjudication],
    context.original,
    roxabiRecordFixtures().projection,
    'operator',
    [graph.history],
    own,
  ).history
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
  const completed = encodeCriterionRecords(
    [final],
    context.original,
    roxabiRecordFixtures().projection,
    'operator',
    [graph.history],
    own,
  ).history
  const bodies = completed.source.comments.map((comment) => comment.body)
  const gh: Gh = async (_cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
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
