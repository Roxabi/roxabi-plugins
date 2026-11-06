import { type DecodedHistory, decodeHistory, readGitHubHistory } from '../dist/contracts.js'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { REVIEW_SCOPE } from './feature-review-fixture.ts'
import { reviewInitialData } from './feature-review-lifecycle.ts'
import { reviewDecision } from './feature-review-synthesis-sources.ts'
import { exerciseNativeDispositionBoundary } from './fix-disposition-native-boundary.ts'
import { createReviewDriver } from './native-review-driver.ts'

function observeHistory(history: DecodedHistory) {
  const { scope, expectedAuthor, stopAuthor, complete, diagnostics } = history.source
  return {
    source: { scope, expectedAuthor, stopAuthor, complete, diagnostics },
    operations: history.operations.map(({ operationId, recordId, kind, status, record, claimedKinds, authority }) => ({
      operationId,
      recordId,
      kind,
      status,
      record,
      claimedKinds,
      authority,
    })),
    diagnostics: history.diagnostics,
  }
}

/** Drive actual review production; only the synthesis judgment differs in the negative scenario. */
export async function invokeDispositionPartition(cwd: string, broken: boolean): Promise<object> {
  const reader = createInstalledUwReadPort({ cwd, readAuthor: 'operator' })
  const initial = await reader.readUw(REVIEW_SCOPE)
  if (initial.accepted.status !== 'accepted') throw new Error('partition-fixture-spec-not-accepted')
  const driver = await createReviewDriver(cwd, 128_000, 'review-only')
  try {
    await driver.settle(reviewInitialData)
    const scope = { repository: REVIEW_SCOPE.repository, target: 'acme/app#7' }
    const before = decodeHistory(await readGitHubHistory(scope, { cwd, readAuthor: 'operator' }))
    await driver.settle((task) => {
      const judgment = reviewDecision(task.task)
      if (!broken) return judgment
      if (!('causes' in judgment) || !Array.isArray(judgment.causes)) throw new Error('review-fixture-cause-missing')
      const cause = judgment.causes[0]
      if (cause === null || typeof cause !== 'object' || Array.isArray(cause))
        throw new Error('review-fixture-cause-missing')
      return { ...judgment, causes: [{ ...cause, findingIds: ['unknown-finding'] }] }
    })
    const after = decodeHistory(await readGitHubHistory(scope, { cwd, readAuthor: 'operator' }))
    const origin = await reader.readUw(REVIEW_SCOPE)
    return {
      initialAccepted: initial.accepted.status,
      accepted: origin.accepted.status,
      originHistories: origin.histories.map(observeHistory),
      before: observeHistory(before),
      after: observeHistory(after),
      diagnostics: driver.diagnostics,
      active: driver.controller.active(),
      fixRun: driver.fixRun() === undefined ? null : { runId: driver.fixRun()?.runId },
    }
  } finally {
    await driver.controller.stop('test-cleanup')
  }
}

export async function invokeDispositionBoundary(
  cwd: string,
  fault: 'original-history' | 'foreign-synthesis',
): Promise<object> {
  const driver = await createReviewDriver(cwd, 128_000, 'review-only')
  try {
    await driver.settle(reviewInitialData)
    await driver.settle((task) => reviewDecision(task.task))
    return await exerciseNativeDispositionBoundary(cwd, driver, fault)
  } finally {
    await driver.controller.stop('test-cleanup')
  }
}
