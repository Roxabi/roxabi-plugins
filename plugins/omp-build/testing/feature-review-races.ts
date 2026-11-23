import { setImmediate as nextTurn } from 'node:timers/promises'
import { readReviewHistory } from '../skills/feature/workflow-records.js'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { failNextPost, type GitBarrier, gitBarrier } from './feature-review-race-barriers.ts'
import { history } from './feature-review-race-history.ts'
import { nextReviewRecords } from './feature-review-race-reviews.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'

type Mode = 'latest' | 'owned-pause'

async function untouchedRequestPrecondition(cwd: string) {
  const source = await history(cwd)
  const requests = source.operations.filter((operation) => operation.record?.kind === 'fix-request')
  if (!source.source.complete || requests.length !== 0) throw new Error('fix-request-written-before-preflight')
  return { complete: true, requests: requests.length }
}

type Cleanup = () => void | Promise<void>

async function cleanupRace(steps: readonly Cleanup[]): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

async function completeRace<T>(work: () => Promise<T>, cleanup: () => Promise<unknown[]>, message: string): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await work() }
  } catch (error) {
    outcome = { ok: false, error }
  }
  const errors = await cleanup()
  if (outcome.ok) {
    if (errors.length > 0) throw new AggregateError(errors, message)
    return outcome.value
  }
  if (errors.length > 0) throw new AggregateError([outcome.error, ...errors], `${message}; primary failure preserved`)
  throw outcome.error
}

async function latest(cwd: string) {
  const driver = await createReviewDriver(cwd)
  try {
    await driver.settle(reviewInitialData)
    await driver.settle((task) => reviewDecision(task.task))
    const summary = await nextReviewRecords(cwd)
    const refusal = await driver.startReview().then(
      () => {
        throw new Error('review bound did not refuse another native review')
      },
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    const finalHistory = await history(cwd)
    return {
      active: driver.controller.active(),
      messages: driver.messages,
      summary,
      refusal,
      records: finalHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
    }
  } finally {
    await driver.controller.stop('race-cleanup')
  }
}

async function assertIssuePauseNotPersisted(cwd: string) {
  const before = await readReviewHistory(cwd, 42)
  if (!before.source.complete) throw new Error('issue-history-incomplete-before-pause')
  if (before.operations.some((operation) => operation.record?.kind === 'operator-control'))
    throw new Error('pause-persisted-before-driver-release')
}

async function ownedPause(cwd: string) {
  const driver = await createReviewDriver(cwd)
  let barrier: GitBarrier | null = null
  let post: { failed(): boolean; premature(): boolean; refused: Promise<void>; release(): void; close(): void } | null =
    null
  let settling: Promise<void> | null = null
  return completeRace(
    async () => {
      await driver.settle(reviewInitialData)
      await driver.settle((task) => reviewDecision(task.task))
      barrier = gitBarrier(30_000)
      settling = driver.startFix()
      await barrier.started
      const precondition = await untouchedRequestPrecondition(cwd)
      const run = driver.fixRun()
      if (run === undefined) throw new Error('owned-fix-run-missing')
      let terminated = false
      void run.driverTerminated.then(() => {
        terminated = true
      })
      post = failNextPost(true)
      let pauseFinished = false
      const pausing = driver.pauseFeature().finally(() => {
        pauseFinished = true
      })
      const outcomes = Promise.allSettled([pausing, settling])
      await nextTurn()
      if (terminated || pauseFinished || post.failed() || driver.fixRun() !== run)
        throw new Error('owned-pause-did-not-join-driver')
      await assertIssuePauseNotPersisted(cwd)
      barrier.release()
      await post.refused
      if (!terminated || driver.fixRun() !== undefined || post.premature())
        throw new Error('pause-post-before-owner-release')
      post.release()
      const [paused] = await outcomes
      settling = null
      if (paused.status === 'rejected') throw paused.reason
      const records = (await history(cwd)).operations.flatMap((operation) =>
        operation.record ? [operation.record] : [],
      )
      const issueHistory = await readReviewHistory(cwd, 42)
      if (!issueHistory.source.complete) throw new Error('issue-history-incomplete-after-pause')
      return {
        precondition,
        ownerReleasedBeforePost: true,
        driverPendingBeforeRelease: true,
        messages: driver.messages,
        records,
        issueRecords: issueHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
      }
    },
    () =>
      cleanupRace([
        () => barrier?.release(),
        () => post?.release(),
        async () => {
          if (settling !== null) await settling.catch(() => {})
        },
        () => post?.close(),
        () => driver.controller.stop('race-cleanup'),
        () => barrier?.close(),
      ]),
    'owned pause race cleanup failed',
  )
}

export async function invokeReviewRace(cwd: string, mode: Mode): Promise<object> {
  return mode === 'latest' ? latest(cwd) : ownedPause(cwd)
}
