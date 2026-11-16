import { execFileSync } from 'node:child_process'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { loadReviewClassCatalogues } from '../roxabi/review-class-catalogues.ts'

import { readReviewHistory, reviewRecords } from '../skills/feature/workflow-records.js'
import { reviewStep } from '../skills/feature/workflow-review-state.js'
import { gh } from '../skills/feature/workflow-runtime.js'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { failNextPost, type GitBarrier, gitBarrier } from './feature-review-race-barriers.ts'
import { citedHistory, history } from './feature-review-race-history.ts'
import { nextReviewRecords } from './feature-review-race-reviews.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { createReviewDriver } from './native-review-driver.ts'

type Mode = 'latest' | 'pause' | 'owned-pause'
function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error instanceof Error ? error.message : String(error)]
}
async function continuationPrerequisites(cwd: string, kind: 'preflight' | 'checkout') {
  const source = await history(cwd)
  const records = source.operations.flatMap((operation) => (operation.record ? [operation.record] : []))
  const externalHistories = await citedHistory(cwd, source)
  const catalogues = await loadReviewClassCatalogues({ histories: [source, ...externalHistories], cwd, gh })
  const summary = reviewRecords(source, { catalogues, externalHistories })
  const requests = records.filter((record) => record.kind === 'fix-request')
  if (kind === 'preflight') {
    if (!source.source.complete || requests.length !== 1) throw new Error('fix-request-not-confirmed-before-race')
    return { complete: true, requests: requests.length }
  }
  const step = summary.ok ? reviewStep(summary.value, { head: summary.value.head }) : null
  if (!source.source.complete || step?.action !== 'fix' || requests.length !== 0)
    throw new Error(
      `fix-selection-not-confirmed-before-pause:${JSON.stringify({ complete: source.source.complete, summary, step, requests })}`,
    )
  return { complete: true, action: step.action, requests: requests.length }
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
  let barrier: GitBarrier | null = null
  let settling: Promise<void> | null = null
  return completeRace(
    async () => {
      await driver.settle(reviewInitialData)
      const armed = gitBarrier('preflight', 30_000)
      barrier = armed
      settling = driver.settle((task) => reviewDecision(task.task))
      await armed.started
      const precondition = await continuationPrerequisites(cwd, 'preflight')
      const summary = await nextReviewRecords(cwd)
      armed.release()
      await settling
      const finalHistory = await history(cwd)
      return {
        active: driver.controller.active(),
        messages: driver.messages,
        precondition,
        summary,
        records: finalHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
      }
    },
    () =>
      cleanupRace([
        () => barrier?.release(),
        async () => {
          if (settling !== null) await settling
        },
        () => driver.controller.stop('race-cleanup'),
        () => barrier?.close(),
      ]),
    'review latest race cleanup failed',
  )
}

async function pause(cwd: string) {
  const driver = await createReviewDriver(cwd)
  let barrier: GitBarrier | null = null
  let closePost: { failed(): boolean; premature(): boolean; refused: Promise<void>; close(): void } | null = null
  let settling: Promise<void> | null = null
  return completeRace(
    async () => {
      await driver.settle(reviewInitialData)
      const armed = gitBarrier('checkout')
      barrier = armed
      settling = driver.settle((task) => reviewDecision(task.task))
      await armed.started
      const precondition = await continuationPrerequisites(cwd, 'checkout')
      if (driver.fixRun() !== undefined) throw new Error('fix-run-started-before-pause')
      closePost = failNextPost()
      let pauseFinished = false
      const pausing = driver.pause().finally(() => {
        pauseFinished = true
      })
      const outcomes = Promise.allSettled([pausing, settling])
      await nextTurn()
      if (pauseFinished || closePost.failed()) throw new Error('pause-did-not-join-checkout-settlement')
      armed.release()
      await closePost.refused
      if (!closePost.failed() || closePost.premature()) throw new Error('pause-post-order-invalid')
      const pausedRecords = (await history(cwd)).operations.flatMap((operation) =>
        operation.record ? [operation.record] : [],
      )
      const controls = pausedRecords.filter((record) => record.kind === 'operator-control')
      if (controls.length !== 0) throw new Error('pause-control-persisted-despite-refusal')
      closePost.close()
      closePost = null
      execFileSync('gh', ['repo', 'view', 'acme/app', '--json', 'nameWithOwner'], { cwd, encoding: 'utf8' })
      const [paused, settled] = await outcomes
      settling = null
      if (paused.status === 'rejected') throw paused.reason
      if (settled.status !== 'rejected') throw new Error('review-settlement-rejection-missing')
      const settlementErrors = errorMessages(settled.reason)
      const finalHistory = await history(cwd)
      return {
        precondition,
        pause: { postRefused: true, operatorControls: controls.length, ghAvailable: true, joinedBeforeRelease: true },
        settlementErrors,
        active: driver.controller.active(),
        fixRun: driver.fixRun(),
        messages: driver.messages,
        records: finalHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
      }
    },
    () =>
      cleanupRace([
        () => barrier?.release(),
        async () => {
          if (settling !== null) await settling
        },
        () => closePost?.close(),
        () => driver.controller.stop('race-cleanup'),
        () => barrier?.close(),
      ]),
    'review pause race cleanup failed',
  )
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
      barrier = gitBarrier('preflight', 30_000)
      settling = driver.settle((task) => reviewDecision(task.task))
      await barrier.started
      const precondition = await continuationPrerequisites(cwd, 'preflight')
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
  return mode === 'latest' ? latest(cwd) : mode === 'owned-pause' ? ownedPause(cwd) : pause(cwd)
}
