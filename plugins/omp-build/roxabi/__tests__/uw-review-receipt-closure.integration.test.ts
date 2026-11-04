import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { readComposedWorkflowHistory, recordsOf, validateCauseDispositionRecords } from '../../dist/contracts.js'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
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
    }),
  ).toEqual([])
  if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted origin')
  const effective = graph.inputs.manifest.spec.effective
  const store: FixDispositionStore = {
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
      { causeContext: { original, effective } },
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
})
