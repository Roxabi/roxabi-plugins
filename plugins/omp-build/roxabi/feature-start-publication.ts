import type { PublicationContextResolver } from '../adapters/github/publication-context.ts'
import type { Gh } from '../adapters/github/types.ts'
import {
  canonicalValueDigest,
  projectWriterRetryHistory,
  readWriterRetryUwCompletionObservation,
  resolveSpecEffective,
} from '../dist/contracts.js'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { diagnostic } from '../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { WorkflowCausalContext } from '../engine/workflow-plan.ts'
import type { Contracts, History } from './feature-engine.ts'
import {
  authorizeExpandedStart,
  hasExpandedStart,
  recheckExpandedStart,
  validateExpandedStartLive,
} from './feature-start-expansion.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { integrationProofInputs } from './uw-action-stage-closure.ts'
import { readInstalledObservedUwTransition } from './uw-read-port.ts'

type Checked = { ok: true } | { ok: false; reason: string }

function hasConfirmedRecord(history: History | undefined, record: CanonicalRecord): boolean {
  let digest: string | undefined
  for (const operation of history?.operations ?? []) {
    if (
      operation.operationId !== record.operationId ||
      operation.authority === 'foreign' ||
      operation.status !== 'complete' ||
      operation.record === null
    )
      continue
    digest ??= canonicalValueDigest(record)
    if (canonicalValueDigest(operation.record) === digest) return true
  }
  return false
}

async function recheckOrdinaryIntegration(
  record: CanonicalRecord,
  inputs: ActionInputs,
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  const scope = { repository: record.repository, target: record.target }
  const causal = await readFreshUwCausalContext(scope, [], withRoxabiGitHubPolicy({ cwd, gh }))
  if (!causal.ok) return { ok: false, reason: 'integration-authority-unreadable' }
  const ownHistory = causal.value.observation.histories.find(
    (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
  )
  if (!hasConfirmedRecord(ownHistory, record)) return { ok: false, reason: 'integration-start-unconfirmed' }
  return authorizeOrdinaryIntegration(inputs, scope, causal.value)
}

export async function authorizeOrdinaryIntegration(
  inputs: ActionInputs,
  scope: Scope,
  causal: WorkflowCausalContext,
): Promise<Checked> {
  const { manifest } = inputs
  const subject = manifest.subject
  if (
    manifest.purpose !== 'integrate' ||
    subject.kind !== 'uw' ||
    subject.uw.repository !== scope.repository ||
    subject.uw.target !== scope.target ||
    subject.pullRequest !== null ||
    subject.binding !== null ||
    causal.observation.root.repository !== scope.repository ||
    causal.observation.root.target !== scope.target ||
    manifest.spec.kind !== 'accepted'
  )
    return { ok: false, reason: 'integration-authority-withdrawn' }
  const read = await readInstalledObservedUwTransition(causal.observation, scope)
  const proof = integrationProofInputs(read)
  if (!proof.ok || read.accepted.status !== 'accepted') return { ok: false, reason: 'integration-authority-withdrawn' }
  const equal = (left: unknown, right: unknown) => canonicalValueDigest(left) === canonicalValueDigest(right)
  const effective = resolveSpecEffective({
    mode: 'current',
    own: read.accepted.value.ref,
    histories: read.observation.histories,
    graph: read.observation.graph,
  })
  if (
    !effective.ok ||
    !equal(effective.value, manifest.spec.effective) ||
    !equal(proof.value.acceptedSources, manifest.acceptedSources) ||
    !equal(proof.value.stageSources, inputs.stageSources)
  )
    return { ok: false, reason: 'integration-authority-withdrawn' }
  return { ok: true }
}

async function resolveOrdinaryIntegrationRetry(
  input: Parameters<PublicationContextResolver>[0],
  resolve: PublicationContextResolver,
  inputs: ActionInputs,
  cwd: string,
  gh: Gh,
): ReturnType<PublicationContextResolver> {
  const { record } = input
  const scope = { repository: record.repository, target: record.target }
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const retry = { record, observed: input.history }
  const home = projectWriterRetryHistory(input.history, retry)
  if (home === null)
    return {
      ok: false,
      diagnostics: [diagnostic('integration-authority-unreadable', 'Writer retry history is invalid')],
    }
  const resolved = await resolve({ ...input, history: home })
  if (!resolved.ok) return resolved
  const observation = await readWriterRetryUwCompletionObservation(retry, options, (histories) =>
    loadReviewClassCatalogues({ histories, cwd, gh }),
  )
  if (observation.status !== 'complete')
    return {
      ok: false,
      diagnostics: [diagnostic('integration-authority-unreadable', 'Writer retry observation is incomplete')],
    }
  const checked = await authorizeOrdinaryIntegration(inputs, scope, {
    observation,
    histories: observation.histories,
    catalogues: observation.catalogues,
  })
  return checked.ok
    ? resolved
    : {
        ok: false,
        diagnostics: [diagnostic(checked.reason, 'Current integration authority is unavailable or changed')],
      }
}

/** Bind the UW decision to the writer's own native history at each resolver cut. */
export function guardOrdinaryIntegrationWriter(
  resolve: PublicationContextResolver,
  cwd: string,
  gh: Gh,
): PublicationContextResolver {
  return async (input) => {
    const record = input.record
    if (
      record.kind !== 'action-receipt' ||
      record.payload.phase !== 'start' ||
      record.payload.action !== 'integrate' ||
      hasExpandedStart(record.payload)
    )
      return resolve(input)
    if (
      input.history.operations.some(
        (operation) =>
          operation.operationId === record.operationId &&
          operation.authority !== 'foreign' &&
          operation.status === 'incomplete',
      )
    )
      return resolveOrdinaryIntegrationRetry(input, resolve, record.payload.inputs, cwd, gh)
    const resolved = await resolve(input)
    if (!resolved.ok) return resolved
    // The post-publication recheck handles an exact confirmed operation before dispatch.
    if (hasConfirmedRecord(input.history, record)) return resolved
    const scope = { repository: record.repository, target: record.target }
    const causal = await readFreshUwCausalContext(scope, [input.history], withRoxabiGitHubPolicy({ cwd, gh }))
    const checked = causal.ok
      ? await authorizeOrdinaryIntegration(record.payload.inputs, scope, causal.value)
      : { ok: false as const, reason: 'integration-authority-unreadable' }
    return checked.ok
      ? resolved
      : {
          ok: false,
          diagnostics: [diagnostic(checked.reason, 'Current integration authority is unavailable or changed')],
        }
  }
}

function startUw(start: Extract<Extract<CanonicalRecord, { kind: 'action-receipt' }>['payload'], { phase: 'start' }>) {
  const bindings =
    start.action === 'plan-review'
      ? start.slots.flatMap((slot) => (slot.action === undefined ? [] : [slot.action.inputs]))
      : [start.inputs]
  const subjects = bindings.map((inputs) => inputs.manifest.subject)
  const first = subjects[0]
  if (first === undefined) return undefined
  if (first.kind === 'standalone-pr')
    return subjects.every(
      (subject) =>
        subject.kind === 'standalone-pr' &&
        subject.pullRequest.repository === first.pullRequest.repository &&
        subject.pullRequest.target === first.pullRequest.target,
    )
      ? null
      : undefined
  return subjects.every(
    (subject) =>
      subject.kind === 'uw' && subject.uw.repository === first.uw.repository && subject.uw.target === first.uw.target,
  )
    ? first.uw
    : undefined
}

export async function authorizeStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'start') return { ok: true }
  if (!hasExpandedStart(record.payload) && record.payload.action !== 'implement') return { ok: true }
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(
    histories.map((item) => item.source.scope),
    options,
  )
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const uw = startUw(record.payload)
  if (uw === undefined) return { ok: false, reason: 'causal-uw-unavailable' }
  const causal = uw === null ? null : await readFreshUwCausalContext(uw, fresh.histories, options)
  if (causal !== null && !causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  if (!hasExpandedStart(record.payload)) return { ok: true }
  const authorized = authorizeExpandedStart(record.payload, fresh.histories, causal?.value ?? null)
  if (!authorized.ok) return authorized
  return validateExpandedStartLive(record.payload, fresh.histories, { cwd, gh })
}

export async function recheckStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'start') return { ok: true }
  const expanded = hasExpandedStart(record.payload)
  if (!expanded && record.payload.action === 'integrate')
    return recheckOrdinaryIntegration(record, record.payload.inputs, cwd, gh)
  if (!expanded && record.payload.action !== 'implement') return { ok: true }
  const scopes = histories.map((item) => item.source.scope)
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(scopes, options)
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const uw = startUw(record.payload)
  if (uw === undefined) return { ok: false, reason: 'causal-uw-unavailable' }
  const causal = uw === null ? null : await readFreshUwCausalContext(uw, fresh.histories, options)
  if (causal !== null && !causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  if (!expanded) return { ok: true }
  const authorized = recheckExpandedStart(record, fresh.histories, causal?.value ?? null)
  if (!authorized.ok) return authorized
  const beforeStart = fresh.histories.map((item) => ({
    ...item,
    operations: item.operations.filter(
      (operation) =>
        operation.record?.recordId !== record.recordId ||
        operation.record?.repository !== record.repository ||
        operation.record?.target !== record.target,
    ),
  }))
  return validateExpandedStartLive(record.payload, beforeStart, { cwd, gh })
}
