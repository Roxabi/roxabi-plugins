import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import {
  readComposedWorkflowHistory,
  recordsOf,
  summarizeReviews,
  validateCauseDispositionRecords,
} from '../../dist/contracts.js'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { operation as observedOperation } from '../../testing/record-history.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { persistCauseDispositions } from '../fix-disposition-execution.ts'
import type { FixDispositionStore } from '../fix-disposition-store.ts'
import { readReviewInputHistories } from '../uw-input-readers.ts'

it('loads a confirmed sister identity through the review input causal closure', async () => {
  const { graph, held, operation, identity, receipt } = sisterRecords()
  const original = { repository: 'acme/app', target: 'acme/app#42' }
  const mandate = roxabiWorkflowFixtures().featureMandate(original, {
    recordId: 'mandate-42',
    body: 'Save the selected region',
  })
  const source = encodeCriterionRecords(
    recordsOf(graph.history).filter((record) => record.kind !== 'review'),
    graph.history.source.scope,
    roxabiRecordFixtures().projection,
    'automation',
    [roxabiWorkflowFixtures().historyFrom([mandate])],
  )
  const comments = new Map([
    [42, [mandate, held, operation, receipt].map((record, index) => nativeComment(index + 1, wire(record)))],
    [43, [nativeComment(10, wire(identity))]],
    [44, source.history.source.comments.map((comment, index) => nativeComment(100 + index, comment.body))],
  ])
  const requested: number[] = []
  const gh: Gh = async (_cwd, args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const number = Number(/issues\/(\d+)\/comments/.exec(endpoint)?.[1])
    if (!comments.has(number)) throw new Error(`unexpected history ${endpoint}`)
    requested.push(number)
    return JSON.stringify(comments.get(number))
  }
  const result = await readReviewInputHistories(graph.history, { cwd: '/fixture', gh, readAuthor: 'automation' })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error('review input history closure refused')
  expect(result.value.map((entry) => entry.source.scope.target)).toContain('acme/app#43')
  expect(requested).toContain(43)
  expect(
    validateCauseDispositionRecords({
      records: [held, operation, receipt],
      histories: [graph.history, ...result.value],
      catalogues: fixtureHostReviewClassCatalogues(),
    }),
  ).toEqual([])
  if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted origin')
  const effective = graph.inputs.manifest.spec.effective
  const date = '2026-10-27T12:00:00.000Z'
  const sister = { repository: original.repository, target: 'acme/app#43' }
  const nativeGraph = {
    status: 'complete' as const,
    root: original,
    observedAt: date,
    nodes: [
      {
        uw: original,
        title: 'Save region',
        raw: rawSource(original.target, 'Save the selected region', date),
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [sister],
        native: { state: 'OPEN' as const, stateReason: null },
      },
      {
        uw: sister,
        title: 'Repair persistence',
        raw: rawSource(sister.target, 'Repair region persistence separately', date),
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN' as const, stateReason: null },
      },
    ],
  }
  const store: FixDispositionStore = {
    async catalogues() {
      return fixtureHostReviewClassCatalogues()
    },
    async read(scopes) {
      const loaded = await readComposedWorkflowHistory(scopes, { cwd: '/fixture', gh, readAuthor: 'automation' })
      return loaded.ok ? { ok: true, value: loaded.histories } : { ok: false, diagnostics: loaded.diagnostics }
    },
    async publish() {
      throw new Error('existing disposition must be reused')
    },
  }
  const persist = () =>
    persistCauseDispositions(
      {
        causeContext: { original, effective },
        graph: nativeGraph,
        capture: { kind: 'action', input: synthesisActionCapture(graph.decision, [source.history]) },
      },
      { kind: 'decision', decision: graph.decision },
      { runId: 'next-run', operationId: 'next-op', nextRecordId: () => 'unused' },
      store,
    )
  const next = await persist()
  expect(next.ok, JSON.stringify(next)).toBe(true)
  if (!next.ok) throw new Error('next correction refused')
  expect(next.value.refs.map((ref) => ref.recordId)).toContain(held.recordId)
  comments.set(43, [])
  const missing = await persist()
  expect(missing.ok).toBe(false)
  comments.set(43, [nativeComment(10, wire({ ...identity, operationId: 'forged-operation' }))])
  const forged = await persist()
  expect(forged.ok).toBe(false)

  // The primary observation belongs to review accounting, not the strict
  // external closure. Its incomplete status must survive dependency loading.
  comments.set(43, [nativeComment(10, wire(identity))])
  const incompleteRoot = { ...graph.history, source: { ...graph.history.source, complete: false } }
  requested.length = 0
  const incomplete = await readReviewInputHistories(incompleteRoot, {
    cwd: '/fixture',
    gh,
    readAuthor: 'automation',
  })
  expect(incomplete.ok, JSON.stringify(incomplete)).toBe(true)
  if (!incomplete.ok) throw new Error('external history closure refused an incomplete primary observation')
  expect(incompleteRoot.source.complete).toBe(false)
  expect(requested).toContain(43)
  // The receipt points back into the primary scope; closure must not reload it.
  expect(requested).not.toContain(44)
  expect(
    validateCauseDispositionRecords({
      records: [held, operation, receipt],
      histories: [incompleteRoot, ...incomplete.value],
      catalogues: fixtureHostReviewClassCatalogues(),
    }).length,
  ).toBeGreaterThan(0)
  expect(summarizeReviews(incompleteRoot, fixtureHostReviewClassCatalogues(), null, incomplete.value).ok).toBe(false)

  const interruptedRoot = {
    ...graph.history,
    operations: [
      ...graph.history.operations,
      observedOperation(graph.review, {
        operationId: 'partial-new-review',
        recordId: 'partial-new-review-record',
        status: 'incomplete',
        record: null,
      }),
    ],
  }
  expect(interruptedRoot.source.complete).toBe(true)
  const interrupted = await readReviewInputHistories(interruptedRoot, {
    cwd: '/fixture',
    gh,
    readAuthor: 'automation',
  })
  expect(interrupted.ok, JSON.stringify(interrupted)).toBe(true)
  if (!interrupted.ok) throw new Error('external history closure refused an interrupted primary operation')
  expect(summarizeReviews(interruptedRoot, fixtureHostReviewClassCatalogues(), null, interrupted.value)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]),
  })

  // A missing or forged external identity remains invalid for either primary
  // observation. An incomplete primary does not relax external authentication.
  for (const root of [graph.history, incompleteRoot]) {
    for (const invalid of [[], [nativeComment(10, wire({ ...identity, operationId: 'forged-operation' }))]]) {
      comments.set(43, invalid)
      const loaded = await readReviewInputHistories(root, { cwd: '/fixture', gh, readAuthor: 'automation' })
      if (!loaded.ok) continue
      expect(
        validateCauseDispositionRecords({
          records: [held, operation, receipt],
          histories: [root, ...loaded.value],
          catalogues: fixtureHostReviewClassCatalogues(),
        }).length,
      ).toBeGreaterThan(0)
    }
  }
  comments.set(43, [nativeComment(10, wire(identity))])
  const unavailable: Gh = async (cwd, args) => {
    if (args.some((arg) => arg.includes('issues/43/comments'))) throw new Error('sister history unavailable')
    return gh(cwd, args)
  }
  for (const root of [graph.history, incompleteRoot]) {
    const loaded = await readReviewInputHistories(root, { cwd: '/fixture', gh: unavailable, readAuthor: 'automation' })
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.diagnostics.map((item) => item.code)).toContain('github-read-failed')
  }
})
