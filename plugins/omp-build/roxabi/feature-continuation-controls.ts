import { randomUUID } from 'node:crypto'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import { mandatesInHistory } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { bindsOwnPause, publishConfirmedPause } from './feature-control.ts'
import { disarmKnownTarget } from './feature-disarm.ts'
import { payload, publishRecord } from './feature-engine.ts'
import { mandateBranch } from './feature-selection.ts'

/** Publishes the source pause or abandon control after authority admission. */
export async function applyFeatureControl(
  control: 'pause' | 'abandon',
  authority: FeatureAuthority,
): Promise<ContinueFeatureResult> {
  const { context, history, scope, selection, target, parentHistories } = authority
  const pausedOwnMandateId =
    control === 'abandon' &&
    selection.status === 'refused' &&
    selection.reason === 'paused' &&
    bindsOwnPause(context.engine, selection, history, scope)
      ? selection.pause.mandate.recordId
      : null
  const pausedOwnMandate =
    pausedOwnMandateId === null
      ? null
      : (mandatesInHistory(history).find((candidate) => candidate.recordId === pausedOwnMandateId) ?? null)
  const mandate = selection.status === 'applicable' ? selection.mandate : pausedOwnMandate
  if (mandate === null) {
    await disarmKnownTarget(context.gh, context.cwd, target, null)
    return { kind: 'blocked', reason: control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  const accepted = context.engine.resolveAcceptedSpec(mandate, [history, ...parentHistories])
  if (!accepted.ok) {
    await disarmKnownTarget(context.gh, context.cwd, target, null)
    return { kind: 'blocked', reason: control === 'pause' ? 'pause-uncertain' : 'abandon-uncertain' }
  }
  const role = context.engine.effectiveMandateRole(mandate.payload.role, accepted.spec)
  const branch = mandateBranch(mandate)
  const mandateRef: ScopedRecordRef = { scope: history.source.scope, recordId: mandate.recordId, kind: 'mandate' }
  if (control === 'pause') {
    return publishConfirmedPause({
      loaded: context.engine,
      history,
      scope,
      target,
      gh: context.gh,
      cwd: context.cwd,
      parentHistories,
      mandate: mandateRef,
      role,
      branch,
      options: { cwd: context.cwd, gh: context.gh },
    })
  }
  const published = await publishRecord(
    context.engine,
    history,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'operator-control',
      payload: { control: 'abandon', controlId: randomUUID(), predecessor: null, mandate: mandateRef },
    },
    context.gh,
    context.cwd,
    parentHistories,
  )
  const disarmed = await disarmKnownTarget(context.gh, context.cwd, target, role, branch)
  if (!published.ok || !disarmed.clean) return { kind: 'abandoned', confirmed: false }
  const reread = await context.engine.readComposedWorkflowHistory([scope], { cwd: context.cwd, gh: context.gh })
  const confirmed =
    reread.ok &&
    reread.histories[0]?.operations.some((operation) => {
      const record = operation.record
      if (
        operation.status !== 'complete' ||
        record === null ||
        record === undefined ||
        record.kind !== 'operator-control'
      )
        return false
      return payload(record).control === 'abandon'
    }) === true
  return { kind: 'abandoned', confirmed }
}
