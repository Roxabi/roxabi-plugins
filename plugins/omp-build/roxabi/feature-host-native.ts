import type { ScopedRecordRef } from '../engine/record-references.ts'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeStop,
} from '../omp/review-runtime/contracts.ts'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureNativePublication } from './feature-contract.ts'
import { correctionSuccessor } from './feature-correction-successor.ts'
import { type OwnedFeature, ownedFeatureFor, rememberFeatureOwner } from './feature-host-ownership.ts'
import { readImplementationStart } from './feature-implementation-start.ts'
import {
  claimStartActivation,
  recordStartActivationFailed,
  recordStartClosedBeforeAdmission,
  recordStartNotActivated,
} from './feature-start-executions.ts'

const actionStarts = new WeakMap<NativeBatch, ScopedRecordRef>()
const implementationStarts = new WeakMap<NativeBatch, string>()

async function notifyPublicationFailure(host: FeatureCommandHost, primary: unknown): Promise<void> {
  const detail = primary instanceof Error ? primary.message : String(primary)
  try {
    await host.send(`feature-stopped: ${detail}`)
  } catch (notification) {
    throw new AggregateError([primary, notification], `Publication failure: ${detail}; notification failed`, {
      cause: primary,
    })
  }
}

async function publishNativeResult(
  host: FeatureCommandHost,
  settled: NativeBatchResult,
  canReport: () => boolean,
  stop?: NativeStop,
) {
  try {
    const start = actionStarts.get(settled.batch)
    if (start === undefined) throw new Error('action-start-missing')
    const startHead = implementationStarts.get(settled.batch)
    return await host.workflow.publishFeatureNativeResult({
      cwd: host.cwd,
      result: settled,
      start,
      ...(startHead === undefined ? {} : { startHead }),
      ...(stop === undefined ? {} : { stop }),
    })
  } catch (error) {
    if (settled.canPublishContext?.() !== false && canReport()) await notifyPublicationFailure(host, error)
    throw error
  }
}
function publicationFailure(publication: Extract<FeatureNativePublication, { published: false }>): string {
  const remote = publication.confirmedRemote
  const failure =
    remote === undefined
      ? publication.reason
      : `${publication.reason} · confirmed remote tip: ${remote.branch} ${remote.tip}`
  return publication.detail ? `${failure} · ${publication.detail}` : failure
}

async function publishCompletedResult(
  host: FeatureCommandHost,
  result: NativeBatchResult,
  canReport: () => boolean,
): Promise<NativeBatch | null> {
  const publication = await publishNativeResult(host, result, canReport)
  if (publication.published) return result.batch
  const failure = new Error(publicationFailure(publication))
  if (canReport()) await notifyPublicationFailure(host, failure)
  if (!publication.retained) throw failure
  return null
}

async function publishStoppedResult(
  host: FeatureCommandHost,
  result: NativeBatchResult,
  stop: NativeStop,
  canReport: () => boolean,
) {
  const publication = await publishNativeResult(host, result, canReport, stop)
  if (!publication.published && canReport())
    await notifyPublicationFailure(host, new Error(publicationFailure(publication)))
  return publication
}
function activateClaimedBatch(
  host: FeatureCommandHost,
  batch: NativeBatch,
  callbacks: NativeBatchCallbacks,
  start: ScopedRecordRef,
): string | null {
  try {
    host.native.activate(batch, callbacks)
    return null
  } catch (error) {
    recordStartActivationFailed(start, batch.operationId)
    return error instanceof Error ? error.message : String(error)
  }
}

function checkedBaseline(
  host: FeatureCommandHost,
  previousOwner: OwnedFeature | undefined,
  start: { ok: true; head: string } | { ok: false; reason: string },
): { head: string } | { reason: string | null } {
  if (ownedFeatureFor(host.key) !== previousOwner || host.featureContinuationInhibited()) return { reason: null }
  return start.ok ? { head: start.head } : { reason: start.reason }
}

function continueOwnedFeature(
  host: FeatureCommandHost,
  reference: string,
  canContinue: () => boolean,
  owns: () => boolean,
): Promise<ContinueFeatureResult> {
  return host.workflow.continueFeature({
    cwd: host.cwd,
    reference,
    control: 'continue',
    owned: () => canContinue() && owns() && !host.featureContinuationInhibited(),
    principal: false,
    ...(host.uw === undefined ? {} : { uw: host.uw, read: host.uw }),
    ...(host.pluginPin === undefined ? {} : { pluginPin: host.pluginPin }),
  })
}

async function deliverContextNegative(
  host: FeatureCommandHost,
  result: NativeBatchResult,
  stop: NativeStop,
  owns: () => boolean,
  deliver: (result: ContinueFeatureResult) => Promise<void>,
): Promise<void> {
  if (result.canPublishContext?.() !== true) return
  const publication = await publishNativeResult(host, result, owns, stop)
  if (result.canPublishContext?.() !== true || !owns()) return
  if (!publication.retained || !('receipt' in publication) || publication.receipt === undefined) {
    await notifyPublicationFailure(
      host,
      new Error(publication.published ? 'action-context-unconfirmed' : publicationFailure(publication)),
    )
    return
  }
  const receipt = publication.receipt
  await deliver({
    kind: 'blocked',
    reason: 'action-context-missing',
    diagnostics: result.children.flatMap((child) =>
      (child.contextBlock?.missing ?? []).map((item) => ({
        code: 'action-context-missing',
        message: item.reason,
        operationId: result.batch.operationId,
        detail: { locator: item.locator, targets: item.targets, receipt: { ...receipt, selector: '/payload' } },
      })),
    ),
  })
}

async function selectFeatureSuccessor(
  host: FeatureCommandHost,
  reference: string,
  canContinue: () => boolean,
  owns: () => boolean,
  deliver: (result: ContinueFeatureResult, current?: () => boolean) => Promise<void>,
) {
  const next = await continueOwnedFeature(host, reference, canContinue, owns)
  if (!canContinue() || !owns() || host.featureContinuationInhibited()) {
    if (next.kind === 'action') recordStartNotActivated(next.start)
    return
  }
  if (next.kind === 'admitted-ci-correction' || next.kind === 'fix') {
    const current = () => canContinue() && owns() && !host.featureContinuationInhibited()
    return correctionSuccessor(next, host, current, deliver)
  }
  await deliver(next)
}

export async function announceFeatureBatch(
  reference: string,
  followUp: NativeBatch,
  actionStart: ScopedRecordRef,
  host: FeatureCommandHost,
  deliver: (result: ContinueFeatureResult, current?: () => boolean) => Promise<void>,
): Promise<void> {
  if (!isNativeBatch(followUp)) {
    recordStartNotActivated(actionStart)
    await host.send('feature-stopped: action-undeliverable')
    return
  }
  if (host.featureContinuationInhibited() || host.principal) {
    recordStartNotActivated(actionStart)
    await host.send('feature-stopped: continuation-inhibited')
    return
  }
  const previousOwner = ownedFeatureFor(host.key)
  let startHead: string | null = null
  if (isImplementationBatch(followUp)) {
    const start = checkedBaseline(host, previousOwner, await readImplementationStart(host))
    if ('reason' in start) {
      recordStartNotActivated(actionStart)
      if (start.reason !== null) await host.send(`feature-stopped: ${start.reason}`)
      return
    }
    startHead = start.head
  }
  let admittedBatch: NativeBatch | null = null
  let completionPublished = false
  const owner = { reference, cwd: host.cwd, pausable: true }
  const owns = () => ownedFeatureFor(host.key) === owner
  const callbacks: NativeBatchCallbacks = {
    onComplete: async (result, canContinue) => {
      if (!canContinue()) return
      completionPublished = true
      admittedBatch = await publishCompletedResult(host, result, owns)
      if (!canContinue()) admittedBatch = null
    },
    onSettled: async (_result, canContinue) => {
      if (!canContinue() || !owns()) return
      if (admittedBatch !== followUp) return
      admittedBatch = null
      if (host.featureContinuationInhibited()) return
      return selectFeatureSuccessor(host, reference, canContinue, owns, deliver)
    },
    onStop: async (_reason, result, stop) => {
      if (result === null || completionPublished) return
      if (stop.kind !== 'context-negative') {
        const publication = await publishStoppedResult(host, result, stop, owns)
        if (publication.retained && stop.kind === 'interrupted' && stop.proof === 'not-dispatched')
          recordStartClosedBeforeAdmission(actionStart, followUp.operationId)
        return
      }
      await deliverContextNegative(host, result, stop, owns, deliver)
    },
  }
  if (!claimStartActivation(actionStart, followUp.operationId)) {
    await host.send('feature-stopped: action-start-already-observed')
    return
  }
  const activationError = activateClaimedBatch(host, followUp, callbacks, actionStart)
  if (activationError !== null) {
    await host.send(`feature-stopped: ${activationError}`)
    return
  }
  actionStarts.set(followUp, actionStart)
  if (startHead !== null) implementationStarts.set(followUp, startHead)
  rememberFeatureOwner(host.key, owner)
  try {
    host.markFeatureBatch(followUp)
    await host.native.announce(followUp)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await host.native.stopOwned(followUp, reason)
    await host.send(`feature-stopped: ${reason}`)
  }
}

function isNativeBatch(value: NativeBatch): boolean {
  return (
    typeof value?.operationId === 'string' &&
    value.operationId.length > 0 &&
    Array.isArray(value.tasks?.tasks) &&
    value.tasks.tasks.length > 0 &&
    value.tasks.tasks.every(
      (task) =>
        typeof task.name === 'string' &&
        task.name.length > 0 &&
        typeof task.agent === 'string' &&
        typeof task.action?.snapshot.indexPath === 'string',
    )
  )
}

function isImplementationBatch(batch: NativeBatch): boolean {
  return batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')
}
