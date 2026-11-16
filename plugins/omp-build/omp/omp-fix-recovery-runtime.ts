import { decodeHistory, projectRecoveryHistories, readGitHubHistory } from '../dist/contracts.js'
import type { Destination } from '../engine/fix-recovery-schema.ts'
import type { RecordPublisher } from '../roxabi/fix-contract.ts'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import type { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { readFixOwnerHistories } from '../roxabi/fix-owner-admission-observation.ts'
import { createGitHubRecordPublisher } from '../roxabi/github-publisher.ts'
import { type OmpBuildExtensionApi, ownFixRun, reportFeatureTerminalStatus } from './omp-controller.ts'
import { finishOwnedFixRun, observeFixRelease } from './omp-fix-release.ts'
import {
  acquireDestinationAdmissionLease,
  type DestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from './review-runtime/destination-admission-lease.ts'

export async function readRecoveryRequestHistory(input: Parameters<typeof readFixOwnerHistories>[0]) {
  const cut = await readFixOwnerHistories(input)
  if (!cut.ok) throw new Error(cut.diagnostics.join(','))
  const projected = projectRecoveryHistories(cut.value.histories)
  if (!projected.ok) throw new Error('fix-recovery-history-projection-refused')
  const home = projected.value.find(
    (item) =>
      item.source.scope.repository === input.pullRequest.repository &&
      item.source.scope.target === input.pullRequest.target,
  )
  if (home === undefined) throw new Error('fix-recovery-history-unavailable')
  return home
}

export function recoveryPublisher(
  uw: Parameters<typeof readFixOwnerHistories>[0]['uw'],
  pullRequest: Parameters<typeof readFixOwnerHistories>[0]['pullRequest'],
  github: Parameters<typeof readFixOwnerHistories>[0]['github'],
  fence: FixExecutionFence,
  rootCurrent: () => boolean,
): RecordPublisher {
  const rawPublisher = createGitHubRecordPublisher(pullRequest, github, null)
  return {
    publish: (record, canPublish) =>
      fence.trackPublication(record, async () => {
        const external =
          uw.repository === pullRequest.repository && uw.target === pullRequest.target
            ? []
            : [decodeHistory(await readGitHubHistory(uw, github))]
        const saved = await rawPublisher.publish(record, external, () => rootCurrent() && (canPublish?.() ?? true))
        return saved.ok ? { ok: true, value: undefined } : saved
      }),
  }
}

export async function withRecoveryLease<T>(
  destination: Destination,
  action: (lease: DestinationAdmissionLease) => Promise<T>,
): Promise<T> {
  const acquired = await acquireDestinationAdmissionLease({ destination })
  if (acquired.status !== 'acquired')
    throw new Error(`fix-recovery-lease-${acquired.status}:${acquired.diagnostics.map((item) => item.code).join(',')}`)
  let outcome: { ok: true; value: T } | { ok: false; error: unknown }
  try {
    outcome = { ok: true, value: await action(acquired.lease) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  let releaseFailure: { error: unknown } | undefined
  try {
    const released = await releaseDestinationAdmissionLease(acquired.lease)
    if (released.status !== 'released')
      throw new Error(`fix-recovery-lease-retained:${released.diagnostics.map((item) => item.code).join(',')}`)
  } catch (error) {
    releaseFailure = { error }
  }
  if (!outcome.ok && releaseFailure !== undefined)
    throw new AggregateError([outcome.error, releaseFailure.error], 'fix-recovery-action-and-lease-release-failed')
  if (!outcome.ok) throw outcome.error
  if (releaseFailure !== undefined) throw releaseFailure.error
  return outcome.value
}

export async function reportRecoveryRun(
  pi: OmpBuildExtensionApi,
  run: FixRun,
  fence: FixExecutionFence,
  target: string,
): Promise<string> {
  const reporting = run.completion.then((result) => {
    reportFeatureTerminalStatus(
      pi,
      result.ok
        ? `/fix ${run.runId} completed with confirmed record ${result.value.recordId}.`
        : `/fix ${run.runId} stopped: ${result.diagnostics.join(', ')}`,
    )
  })
  const finish = () => finishOwnedFixRun(pi, run, fence, 'fix')
  const release = reporting.then(finish, finish)
  observeFixRelease(release)
  ownFixRun(pi, { run, reporting, release })
  const started = await run.started
  if (started.status === 'terminal') {
    await release
    if (!started.result.ok) throw new Error(started.result.diagnostics.join(','))
    return `Fix recovery completed with confirmed result ${started.result.value.recordId}.`
  }
  return `Confirmed fix recovery started for ${target}.`
}
