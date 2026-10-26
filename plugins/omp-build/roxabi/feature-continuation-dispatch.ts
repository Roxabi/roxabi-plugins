import { randomUUID } from 'node:crypto'
import type { PauseBinding } from '../engine/workflow-control.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { releaseCwdInhibition, releaseInhibition } from './feature-control.ts'
import { isRecord, payload, publishRecord } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'

/** Publishes a validated resume control; null means the source publication succeeded. */
export async function resumePausedFeature(input: {
  pause: PauseBinding
  authority: FeatureAuthority
  observation: FeatureObservation
}): Promise<ContinueFeatureResult | null> {
  const { pause, authority, observation } = input
  const { context, scope } = authority
  if (
    !matchesRecordRef(pause.mandate, scope, pause.mandate.recordId, 'mandate') ||
    !matchesRecordRef(pause.confirmation, scope, pause.confirmation.recordId, 'operator-control')
  ) {
    return { kind: 'blocked', reason: 'resume-pause-unreadable' }
  }
  const mandate = context.engine.bindExternalRef(pause.mandate, observation.evidence.issue)
  const confirmation = context.engine.bindExternalRef(pause.confirmation, observation.evidence.issue)
  if (
    !mandate.ok ||
    !confirmation.ok ||
    confirmation.value.kind !== 'operator-control' ||
    !isRecord(payload(confirmation.value))
  ) {
    return { kind: 'blocked', reason: 'resume-pause-unreadable' }
  }
  const body = payload(confirmation.value)
  const controlId = typeof body.controlId === 'string' && body.controlId.length > 0 ? body.controlId : null
  if (
    body.control !== 'pause-confirmed' ||
    controlId === null ||
    !matchesRecordRef(body.mandate, pause.mandate.scope, pause.mandate.recordId, pause.mandate.kind)
  ) {
    return { kind: 'blocked', reason: 'resume-pause-unreadable' }
  }
  const published = await publishRecord(
    context.engine,
    observation.evidence.issue,
    {
      repository: scope.repository,
      target: scope.target,
      version: 1,
      recordId: randomUUID(),
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'operator-control',
      payload: { control: 'resume', controlId, predecessor: pause.confirmation, mandate: pause.mandate },
    },
    context.gh,
    context.cwd,
    observation.evidence.parents,
  )
  if (!published.ok) return { kind: 'blocked', reason: published.reason, diagnostics: published.diagnostics }
  releaseInhibition(scope)
  releaseCwdInhibition(context.cwd)
  return null
}

function matchesRecordRef(value: unknown, scope: FeatureAuthority['scope'], recordId: string, kind: string): boolean {
  return (
    isRecord(value) &&
    isRecord(value.scope) &&
    value.scope.repository === scope.repository &&
    value.scope.target === scope.target &&
    value.recordId === recordId &&
    value.kind === kind
  )
}
