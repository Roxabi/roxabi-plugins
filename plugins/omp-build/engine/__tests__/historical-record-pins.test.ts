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
  return { issue: history([mandate, start]), foreign: history([cited], other), expanded, cited }
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

test.each(['added foreign comment', 'edited foreign comment', 'replaced cited record', 'changed cited body'] as const)(
  'authenticates agreeing cited records across separate native reads: %s',
  async (change) => {
    const { issue: first, foreign, expanded, cited } = fixture()
    const { issue: second } = fixture()
    const unrelated = {
      locator: 'comment-99',
      nativeId: '99',
      author: 'outside-contributor',
      body: 'Unrelated discussion',
      createdAt: '2026-10-27T12:00:00.000Z',
      updatedAt: '2026-10-27T12:00:00.000Z',
    }
    const before =
      change === 'edited foreign comment' ? [...foreign.source.comments, unrelated] : foreign.source.comments
    const changed = must(
      buildRecord({ ...cited, payload: { ...cited.payload, config: { ...cited.payload.config, version: 'changed' } } }),
    )
    let after: typeof before
    if (change === 'replaced cited record') {
      after = foreign.source.comments.map((comment) => ({
        ...comment,
        nativeId: String(100 + Number(comment.nativeId)),
      }))
    } else if (change === 'changed cited body') {
      after = history([changed], other).source.comments
    } else {
      after = [
        ...foreign.source.comments,
        change === 'added foreign comment'
          ? unrelated
          : { ...unrelated, body: 'Edited discussion', updatedAt: '2026-10-27T12:01:00.000Z' },
      ]
    }
    const observe = (source: typeof first, comments: typeof before) =>
      observeHistoricalPins(source, {
        cwd: '/fixture',
        gh: servesForeign({ ...foreign, source: { ...foreign.source, comments } }),
        readAuthor: 'operator',
      })
    await observe(first, before)
    await observe(second, after)
    expect(authenticateHistoricalActionInputs(expanded, [first]).ok).toBe(true)
    expect(authenticateHistoricalActionInputs(expanded, [second]).ok).toBe(change !== 'changed cited body')
    expect(authenticateHistoricalActionInputs(expanded, [first, second]).ok).toBe(
      change === 'added foreign comment' || change === 'edited foreign comment',
    )
  },
)
