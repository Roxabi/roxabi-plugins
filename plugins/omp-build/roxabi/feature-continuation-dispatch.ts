import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PauseBinding } from '../engine/workflow-control.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { FeatureObservation } from './feature-continuation-observation.ts'
import { proofSelectorFor } from './feature-continuation-proof.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { releaseCwdInhibition, releaseInhibition } from './feature-control.ts'
import { isRecord, payload, publishRecord } from './feature-engine.ts'

const execFileAsync = promisify(execFile)

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

/** Runs proof acquisition and confirms the freshly selected exact candidate head. */
export async function acquireFeatureProof(
  authority: FeatureAuthority,
  observation: FeatureObservation,
): Promise<ContinueFeatureResult | null> {
  const { context, scope } = authority
  const { delivery } = observation
  if (delivery === null) return { kind: 'blocked', reason: 'proof-requires-pull-request' }
  const script = fileURLToPath(new URL('../skills/feature/proof-acquire.ts', import.meta.url))
  try {
    await execFileAsync('bun', ['--no-env-file', script, '--pr', String(delivery.number)], {
      cwd: context.cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch (error) {
    const failed = error !== null && typeof error === 'object' ? error : {}
    const stderr = 'stderr' in failed && typeof failed.stderr === 'string' ? failed.stderr.trim() : ''
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: 'blocked',
      reason:
        stderr.length > 0
          ? `proof-acquire-failed:${stderr.slice(0, 240)}`
          : `proof-acquire-failed:${message.slice(0, 240)}`,
    }
  }
  const readiness = await proofSelectorFor({
    cwd: context.cwd,
    repository: scope.repository,
    delivery,
    git: context.git,
    gh: context.gh,
  })
  if (!readiness.ok) return { kind: 'blocked', reason: readiness.reason }
  const admission = readiness.selector.admission
  if (
    admission === null ||
    admission.candidateGitSHA !== delivery.head ||
    readiness.selector.candidateGitSHA !== delivery.head
  ) {
    return { kind: 'blocked', reason: 'proof-acquire-unconfirmed' }
  }
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
