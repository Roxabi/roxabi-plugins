import { describe, expect, it } from 'vitest'
import { githubScope } from '../adapters/github/transport.ts'
import type { Gh } from '../adapters/github/types.ts'
import { TAXONOMY } from '../engine/__tests__/record-test-support.ts'
import { SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'
import { createPreparedReviewRunner } from './review-entry.ts'
import {
  ghGrantInterruptedReviewReplacement,
  ghReplaceInterruptedReview,
  ghTerminalizeInterruptedReview,
} from './review-recovery-gh.ts'
import {
  completedReplacementRecords,
  preparedReview,
  recoveryFixture,
  recoverySmokeCwd,
} from './review-recovery-gh-test-support.ts'

type Target = 'decision' | 'review' | 'none'

async function exercise(target: Target) {
  const fixture = recoveryFixture()
  const prepareReview = async () => preparedReview()
  expect(await ghTerminalizeInterruptedReview({ cwd: recoverySmokeCwd, pr: 42, gh: fixture.gh })).toMatchObject({
    ok: true,
  })
  expect(
    await ghGrantInterruptedReviewReplacement({
      cwd: recoverySmokeCwd,
      pr: 42,
      contextWindow: 128_000,
      gh: fixture.gh,
      prepareReview,
      operations: preparedReview().value.operations,
    }),
  ).toMatchObject({ ok: true })
  const replacement = await ghReplaceInterruptedReview({
    cwd: recoverySmokeCwd,
    pr: 42,
    contextWindow: 128_000,
    gh: fixture.gh,
    prepareReview,
    operations: preparedReview().value.operations,
  })
  if (!replacement.ok) throw new Error('replacement inventory was not published')
  const records = completedReplacementRecords(replacement.value.inventory)
  const [spec, panel, synthesis, source, decision] = records
  if (synthesis.kind !== 'review-attempt' || source.kind !== 'contribution' || decision.kind !== 'decision')
    throw new Error('invalid fixture')
  const publisher = createGitHubRecordPublisher(
    githubScope(SCOPE.repository, 42),
    withRoxabiGitHubPolicy({ cwd: recoverySmokeCwd, gh: fixture.gh }),
    { taxonomy: TAXONOMY, acceptedPolicy: null },
  )
  for (const record of [spec, panel]) expect(await publisher.publish(record)).toMatchObject({ ok: true })

  let finalizing = false
  let stageReads = 0
  const suspended = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const posts: string[] = []
  const gh: Gh = async (cwd, args) => {
    if (args.includes('POST')) posts.push(args.join(' '))
    const isFirstPage = args.includes('repos/acme/app/issues/42/comments?per_page=100&page=1')
    const selectedStage =
      target === 'decision' ? runner.confirmedDecisionId() === null : runner.confirmedDecisionId() !== null
    if (finalizing && target !== 'none' && selectedStage && isFirstPage && ++stageReads === 2) {
      suspended.resolve()
      await release.promise
    }
    return fixture.gh(cwd, args)
  }
  const runner = createPreparedReviewRunner(
    preparedReview().value,
    { cwd: recoverySmokeCwd, gh },
    async () => ({ ok: true }),
    { initialInventory: replacement.value.inventory },
  )
  const initial = runner.initialBatch()
  expect(await runner.publishInventory(initial)).toEqual({ ok: true })
  const batch = { ...initial, stage: 'synthesis' as const, inventory: synthesis }
  expect(await runner.publishInventory(batch)).toEqual({ ok: true })
  expect(await publisher.publish(source)).toMatchObject({ ok: true })
  const child: NativeChildResult = {
    id: 'synthesis-child',
    expectedId: 'synthesis',
    submissions: [],
    proofEvidence: null,
    raw: null,
    partialText: null,
    structured: decision.payload.judgment,
    usable: true,
    reason: null,
  }
  const before = fixture.commentCount()
  let owned = true
  // Each selected stage first reads finalization history; its second read is
  // publishChecked's fresh history, before any POST for that record.
  finalizing = true
  const finalization = runner.completeStage(
    batch,
    { batch: batch.batch, children: [child], raw: null, complete: true },
    [{ id: source.recordId, child }],
    () => owned,
  )
  if (target !== 'none') {
    await Promise.race([
      suspended.promise,
      finalization.then(() => {
        throw new Error('finalization completed before the publisher history barrier')
      }),
    ])
    const postsBeforeRevocation = posts.length
    owned = false
    release.resolve()
    await expect(finalization).rejects.toThrow(`${target}-unconfirmed:publication-ownership-revoked`)
    expect(posts).toHaveLength(postsBeforeRevocation)
  } else {
    await expect(finalization).resolves.toBeNull()
  }
  const history = await fixture.history()
  const published = history.operations.flatMap((operation) => (operation.record === null ? [] : [operation.record]))
  const finalDecisions = published.filter((record) => record.kind === 'decision')
  const finalReviews = published.filter((record) => record.kind === 'review')
  if (target === 'decision') {
    expect(fixture.commentCount()).toBe(before)
    expect(finalDecisions).toHaveLength(0)
    expect(finalReviews).toHaveLength(0)
  } else if (target === 'review') {
    expect(finalDecisions).toHaveLength(1)
    expect(finalReviews).toHaveLength(0)
  } else {
    expect(finalDecisions).toHaveLength(1)
    expect(finalReviews).toHaveLength(1)
    expect(finalReviews[0]).toMatchObject({ payload: { decisionId: finalDecisions[0].recordId } })
  }
}

describe('review finalization publication ownership', () => {
  it('revokes the decision while its publisher history read is suspended', () => exercise('decision'))
  it('revokes the final review while its publisher history read is suspended', () => exercise('review'))
  it('confirms the real decision and final review with valid ownership', () => exercise('none'))
})
