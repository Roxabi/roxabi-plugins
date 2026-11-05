import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { buildRecord } from '../../dist/contracts.js'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { reportFixture, subtreeGraph } from '../../testing/uw-installed-report-fixture.ts'
import { createInstalledUwReadPort } from '../uw-read-port.ts'

it('keeps the native reader and trusted stop writer across root and referenced histories', async () => {
  const root = reportFixture(42, 44)
  const child = reportFixture(43, 45)
  const review = root.sourceRecords.find((record) => record.kind === 'review')
  if (!review) throw new Error('expected source review')
  const stop = buildRecord({
    version: 1,
    repository: review.repository,
    target: review.target,
    recordId: 'ci-stop',
    runId: 'ci-stop-run',
    operationId: 'ci-stop-operation',
    kind: 'stop',
    payload: { reason: 'ci-failed', reviewId: review.recordId, detail: { ci: 'red' } },
  })
  if (!stop.ok) throw new Error(JSON.stringify(stop.diagnostics))
  const spoof = buildRecord({ ...root.mandate, recordId: 'bot-spoof-mandate', operationId: 'bot-spoof-op' })
  if (!spoof.ok) throw new Error(JSON.stringify(spoof.diagnostics))
  const comments = new Map([
    [42, [root.mandate, root.report]],
    [43, [child.mandate, child.report]],
    [44, root.sourceRecords],
    [45, child.sourceRecords],
  ])
  const gh: Gh = async (_cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    if (args[1] === 'graphql') return subtreeGraph(args)
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const number = Number(/issues\/(\d+)\/comments/.exec(endpoint)?.[1])
    const records = comments.get(number)
    if (!records) throw new Error(`unexpected history ${endpoint}`)
    const result = records.map((record, index) => nativeComment(number * 100 + index, wire(record)))
    if (number === 42) {
      result.push({ ...nativeComment(4299, wire(spoof.value)), user: { login: 'github-actions[bot]' } })
    }
    if (number === 44) {
      result.push({ ...nativeComment(4499, wire(stop.value)), user: { login: 'github-actions[bot]' } })
    }
    return JSON.stringify(result)
  }
  const read = await createInstalledUwReadPort({ cwd: '/fixture', gh, readAuthor: 'automation' }).readUw({
    repository: 'acme/app',
    target: 'acme/app#42',
  })
  const rootHistory = read.histories.find((history) => history.source.scope.target === 'acme/app#42')
  const sourceHistory = read.histories.find((history) => history.source.scope.target === 'acme/app#44')
  expect(rootHistory?.source).toMatchObject({ expectedAuthor: 'automation', stopAuthor: 'github-actions[bot]' })
  expect(sourceHistory?.source).toMatchObject({ expectedAuthor: 'automation', stopAuthor: 'github-actions[bot]' })
  expect(rootHistory?.operations.find((operation) => operation.recordId === root.mandate.recordId)).toMatchObject({
    status: 'complete',
    record: root.mandate,
    parts: [expect.objectContaining({ author: 'automation' })],
  })
  expect(rootHistory?.operations.find((operation) => operation.recordId === spoof.value.recordId)).toMatchObject({
    authority: 'foreign',
  })
  expect(sourceHistory?.operations.find((operation) => operation.recordId === review.recordId)).toMatchObject({
    status: 'complete',
    record: review,
    parts: [expect.objectContaining({ author: 'automation' })],
  })
  const stopOperation = sourceHistory?.operations.find((operation) => operation.recordId === stop.value.recordId)
  expect(stopOperation).toMatchObject({
    status: 'complete',
    record: stop.value,
    parts: [expect.objectContaining({ author: 'github-actions[bot]' })],
  })
  expect(stopOperation?.authority).not.toBe('foreign')
})
