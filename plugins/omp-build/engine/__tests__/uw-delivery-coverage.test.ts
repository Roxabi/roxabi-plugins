import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { deliveryCoverage } from '../uw-delivery-coverage.ts'
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
