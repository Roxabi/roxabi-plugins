import { expect, test } from 'vitest'
import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { authenticateHistoricalActionInputs } from '../historical-action-inputs.ts'
import { buildRecord } from '../record-construction.ts'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

const other = { ...SCOPE, target: `${SCOPE.repository}#43` }

function fixture() {
  const mandate = shippedFeatureMandate()
  const origin = mandateAssessmentState(mandate)
  const prior = assessFixture(
    mandate,
    'assessment',
    origin,
    proposedAssessmentState(origin, { body: 'New edition' }),
    'editorial',
    [history([mandate])],
  )
  if (prior.start.kind !== 'action-receipt') throw new Error('Expected native assessment receipt')
  const cited = must(buildRecord({ ...mandate, ...other, recordId: 'expanded-record' }))
  const ref = {
    source: 'record' as const,
    record: { scope: other, kind: cited.kind, recordId: cited.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(cited.payload),
  }
  const inputs = prior.start.payload.inputs
  const manifest = { ...inputs.manifest, expandedContext: [ref] }
  const expanded = { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const start = must(buildRecord({ ...prior.start, payload: { ...prior.start.payload, inputs: expanded } }))
  return { issue: history([mandate, start]), foreign: history([cited], other), expanded }
}

function servesForeign(foreign: ReturnType<typeof history>): Gh {
  return async (_cwd, args) => {
    if (args[1] !== 'repos/acme/app/issues/43/comments?per_page=100&page=1') throw new Error(args.join(' '))
    return JSON.stringify(
      foreign.source.comments.map((comment) => ({
        id: Number(comment.nativeId),
        body: comment.body,
        user: { login: comment.author },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      })),
    )
  }
}

test('historical expanded records must bind to an observed native value in their own scope', async () => {
  const { issue, foreign, expanded } = fixture()
  expect(authenticateHistoricalActionInputs(expanded, [issue]).ok).toBe(false)

  const observed = await observeHistoricalPins(issue, {
    cwd: '/fixture',
    gh: servesForeign(foreign),
    readAuthor: 'operator',
  })
  expect(authenticateHistoricalActionInputs(expanded, [observed]).ok).toBe(true)

  const freshMissingScope = history([], other)
  expect(authenticateHistoricalActionInputs(expanded, [observed, freshMissingScope]).ok).toBe(false)
})
