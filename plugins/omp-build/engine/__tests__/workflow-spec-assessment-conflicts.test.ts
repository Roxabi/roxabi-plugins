import { expect, test } from 'vitest'
import { parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

test('rejects competing, malformed, and unauthenticated assessments without dropping valid editorial continuity', () => {
  const mandated = shippedFeatureMandate()
  const initial = mandateAssessmentState(mandated)
  const editorial = assessFixture(
    mandated,
    'edit',
    initial,
    proposedAssessmentState(initial, { body: 'editorial body' }),
    'editorial',
    [history([mandated])],
  )
  const sibling = assessFixture(
    mandated,
    'sibling',
    initial,
    proposedAssessmentState(initial, { body: 'sibling body' }),
    'editorial',
    [history([mandated])],
    undefined,
    'other-mandate',
  )
  const kept = resolveAcceptedSpec(mandated, [
    history([mandated, sibling.start, sibling.result, editorial.start, editorial.result]),
  ])
  expect(kept).toMatchObject({ ok: true, spec: { ref: { version: editorial.currentVersion } } })

  const reversed = assessFixture(
    mandated,
    'rev',
    initial,
    proposedAssessmentState(initial, { body: 'other body' }),
    'editorial',
    [history([mandated])],
  )
  expect(
    resolveAcceptedSpec(mandated, [
      history([mandated, reversed.start, reversed.result, editorial.start, editorial.result]),
    ]),
  ).toMatchObject({ ok: false, evidence: [{ code: 'ambiguous' }] })

  const malformed = assessFixture(
    mandated,
    'malformed',
    initial,
    proposedAssessmentState(initial, { body: 'malformed body' }),
    null,
    [history([mandated])],
  )
  expect(resolveAcceptedSpec(mandated, [history([mandated, malformed.start, malformed.result])])).toMatchObject({
    ok: false,
    reason: 'incomplete',
  })
  expect(resolveAcceptedSpec(mandated, [history([mandated, editorial.start])])).toMatchObject({
    ok: false,
    reason: 'incomplete',
  })

  const duplicate = must(parseRecord({ ...editorial.result, recordId: 'edit-again', operationId: 'op-edit-again' }))
  expect(
    resolveAcceptedSpec(mandated, [history([mandated, editorial.start, duplicate, editorial.result])]),
  ).toMatchObject({ ok: false, evidence: [{ code: 'ambiguous' }] })

  const failed = assessFixture(
    mandated,
    'failed',
    initial,
    proposedAssessmentState(initial, { body: 'failed body' }),
    'editorial',
    [history([mandated])],
    { completion: 'error', strict: 'valid' },
  )
  expect(resolveAcceptedSpec(mandated, [history([mandated, failed.start, failed.result])])).toMatchObject({
    ok: false,
    reason: 'incomplete',
  })

  const driftStart = assessFixture(
    mandated,
    'drift-start-source',
    initial,
    proposedAssessmentState(initial, { body: 'start-only body' }),
    'editorial',
    [history([mandated])],
  )
  const driftResult = assessFixture(
    mandated,
    'drift-result-source',
    initial,
    proposedAssessmentState(initial, { body: 'result-only body' }),
    'editorial',
    [history([mandated])],
  )
  if (driftStart.start.kind !== 'action-receipt') throw new Error('expected assessment start fixture')
  const driftStartPayload = driftStart.start.payload
  if (driftStartPayload.phase !== 'start' || driftStartPayload.action !== 'assess-spec')
    throw new Error('expected assessment start fixture')
  const driftedStart = must(
    parseRecord({
      ...driftStart.start,
      recordId: 'drift-start',
      operationId: 'op-drift-start',
      payload: { ...driftStartPayload, actionId: 'act-drift' },
    }),
  )
  const driftedResult = must(
    parseRecord({
      ...driftResult.result,
      recordId: 'drift',
      operationId: 'op-drift',
      inputs: driftResult.result.inputs.map((input) =>
        input === driftResult.start.recordId ? driftedStart.recordId : input,
      ),
      payload: {
        ...driftResult.result.payload,
        actionId: 'act-drift',
        start: { scope: SCOPE, recordId: driftedStart.recordId, kind: 'action-receipt' },
      },
    }),
  )
  expect(resolveAcceptedSpec(mandated, [history([mandated, driftedStart, driftedResult])])).toMatchObject({
    ok: false,
    reason: 'incomplete',
  })
})
