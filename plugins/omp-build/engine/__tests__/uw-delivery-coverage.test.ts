import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { deliveryCoverage } from '../uw-delivery-coverage.ts'
import { bindExternalRef } from '../workflow-control.ts'
import { featureMandate, history, must, SCOPE } from './workflow-test-support.ts'

const original = featureMandate()
const ref = { scope: SCOPE, recordId: original.recordId, kind: 'mandate' as const }
const next = must(
  parseRecord({
    ...original,
    recordId: 'next',
    operationId: 'next-op',
    inputs: [...original.inputs, ref.recordId],
    payload: { ...original.payload, antecedent: ref, config: { ...original.payload.config, productVersion: '0.18.8' } },
  }),
)
if (next.kind !== 'mandate') throw new Error('Expected successor mandate fixture')
const control = must(
  buildRecord({
    ...SCOPE,
    version: 1,
    recordId: 'control',
    runId: 'control',
    operationId: 'control-op',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'control',
      mandate: ref,
      predecessor: ref,
      successor: { scope: SCOPE, recordId: 'next', kind: 'mandate' },
    },
  }),
)

test('requires a new-policy successor control to cover legacy home history', () => {
  expect(deliveryCoverage(history([original]))).toMatchObject({ ok: true, uncovered: true })
  expect(deliveryCoverage(history([original, next, control]))).toMatchObject({
    ok: true,
    uncovered: false,
    branches: ['feature/bounded'],
  })
})

test('a legacy successor control cannot establish the new coverage boundary', () => {
  const oldNext = must(
    parseRecord({
      ...next,
      payload: { ...next.payload, config: { ...next.payload.config, productVersion: '0.18.7' } },
    }),
  )
  expect(deliveryCoverage(history([original, oldNext, control]))).toMatchObject({ ok: true, uncovered: true })
})

test('refuses an off-lineage legacy mandate appended after the boundary', () => {
  const later = must(parseRecord({ ...original, recordId: 'later', operationId: 'later-op' }))
  expect(deliveryCoverage(history([original, next, control, later]))).toMatchObject({ ok: false })
  expect(deliveryCoverage(history([original, next, later, control]))).toMatchObject({ ok: false })
})

test('a valid old-policy successor after the new-policy cut is explicitly refused', () => {
  const nextRef = { scope: SCOPE, recordId: next.recordId, kind: 'mandate' as const }
  const later = must(
    parseRecord({
      ...original,
      recordId: 'later-valid',
      operationId: 'later-valid-op',
      inputs: [...original.inputs, nextRef.recordId],
      payload: { ...original.payload, antecedent: nextRef },
    }),
  )
  const laterRef = { scope: SCOPE, recordId: later.recordId, kind: 'mandate' as const }
  const laterControl = must(
    buildRecord({
      ...SCOPE,
      version: 1,
      recordId: 'later-control',
      runId: 'later-control',
      operationId: 'later-control',
      kind: 'operator-control',
      payload: {
        control: 'select-successor',
        controlId: 'later-control',
        mandate: nextRef,
        predecessor: nextRef,
        successor: laterRef,
      },
    }),
  )
  expect(deliveryCoverage(history([original, next, control, later, laterControl]))).toMatchObject({
    ok: false,
    diagnostics: [
      { code: 'legacy-coverage-incomplete', message: 'Legacy mandate appears after the coverage boundary' },
    ],
  })
})

test('refuses a complete legacy mandate whose parts straddle the successor first part', () => {
  const baseline = history([original, next, control])
  const originalOperation = baseline.operations.find((operation) => operation.recordId === original.recordId)
  const successorOperation = baseline.operations.find((operation) => operation.recordId === next.recordId)
  if (originalOperation === undefined || successorOperation === undefined || originalOperation.parts.length !== 1)
    throw new Error('Expected single-part baseline mandates')
  const originalPart = baseline.source.comments.find(
    (comment) => comment.locator === originalOperation.parts[0]?.locator,
  )
  const nextPart = successorOperation.parts[0]
  if (originalPart === undefined || nextPart === undefined) throw new Error('Missing baseline mandate parts')
  const oldBodies = must(encodeParts(original, '# mandate', 400))
  expect(oldBodies.length).toBeGreaterThan(1)
  const splitParts = oldBodies.map((body) => ({ ...originalPart, body }))
  const beforeSuccessor = baseline.source.comments.flatMap((comment) =>
    comment.locator === originalPart.locator ? splitParts : [comment],
  )
  const cut = beforeSuccessor.findIndex((comment) => comment.locator === nextPart.locator)
  const oldStart = beforeSuccessor.indexOf(splitParts[0])
  if (cut < 0 || oldStart < 0) throw new Error('Missing ordering anchors')
  const straddled = [...beforeSuccessor]
  const tail = straddled.splice(oldStart + 1, splitParts.length - 1)
  const successorIndex = straddled.findIndex((comment) => comment.locator === nextPart.locator)
  straddled.splice(successorIndex + 1, 0, ...tail)
  const decoded = (comments: typeof straddled) =>
    decodeHistory({
      ...baseline.source,
      comments: comments.map((comment, index) => ({
        ...comment,
        nativeId: String(index + 1),
        locator: `${SCOPE.target}:comment:${index + 1}`,
      })),
    })
  const complete = decoded(beforeSuccessor)
  const crossed = decoded(straddled)
  for (const record of [original, next, control]) {
    expect(bindExternalRef({ scope: SCOPE, kind: record.kind, recordId: record.recordId }, crossed)).toMatchObject({
      ok: true,
    })
  }
  expect(deliveryCoverage(complete)).toMatchObject({ ok: true, uncovered: false })
  expect(deliveryCoverage(crossed)).toMatchObject({
    ok: false,
    diagnostics: [
      { code: 'legacy-coverage-incomplete', message: 'Legacy mandate appears after the coverage boundary' },
    ],
  })
})

test('an incomplete home never supplies a coverage boundary', () => {
  const home = history([original, next, control])
  expect(deliveryCoverage({ ...home, source: { ...home.source, complete: false } })).toMatchObject({ ok: false })
})

test('partial successor control never establishes coverage', () => {
  const home = history([original, next, control])
  const part = home.operations.find((operation) => operation.recordId === control.recordId)?.parts[0]
  if (part === undefined) throw new Error('missing control part')
  const damaged = decodeHistory({
    ...home.source,
    comments: home.source.comments.map((comment) =>
      comment.locator === part.locator ? { ...comment, body: comment.body.replace('part=1/1', 'part=1/2') } : comment,
    ),
  })
  expect(deliveryCoverage(damaged)).toMatchObject({ ok: false })
})
