import { parseIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { rawSource } from '../adapters/github-native/uw-spec-parser.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { issueSpecAnalysisSchema } from '../engine/issue-spec-analysis-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Result } from '../engine/result.ts'
import { resolveOwnSpecEffective } from '../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import { historyFor } from '../engine/workflow-control.ts'
import { selectWorkflowBinding } from '../engine/workflow-pr-binding.ts'
import { type EvidenceObservation, resolveEvidenceBasis, seedEvidenceObservation } from './uw-action-basis.ts'
import type {
  ActionInputManifest,
  ActionSubject,
  CurrentActionFacts,
  RecordInputRef,
  UwActionRequest,
} from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import {
  type ActionFactSource,
  authenticate,
  configuration,
  observeCode,
  readHistories,
  sourceRef,
} from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import {
  assertCurrentOutputClosure,
  currentAccountedMandate,
  currentRootOutputRefs,
  selectDeliveryData,
} from './uw-action-selection.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'

const ACCEPTED_PURPOSE: Record<string, true> = {
  plan: true,
  'plan-review': true,
  implement: true,
  'attribute-ci': true,
  review: true,
  correction: true,
}

export type { ActionFactSource }

function bindSubject(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  histories: readonly DecodedHistory[],
  observed: { branch: string; baseName: string },
): Result<{ subject: ActionSubject; mandate: ReturnType<typeof currentAccountedMandate> }> {
  const pull = subject.pullRequest
  let bound: ActionSubject = subject
  const issueHistory = historyFor(subject.uw, histories)
  const mandate =
    issueHistory === null
      ? actionFailure('action-input-missing', 'UW history is absent')
      : currentAccountedMandate(issueHistory)
  if (ACCEPTED_PURPOSE[request.purpose] && !mandate.ok) return mandate
  if (pull === null) return { ok: true, value: { subject, mandate } }
  const selected = selectWorkflowBinding({
    pullRequest: pull,
    histories,
    native: { branch: observed.branch, base: observed.baseName },
  })
  if (selected.status !== 'bound') {
    if (ACCEPTED_PURPOSE[request.purpose])
      return actionFailure('action-input-missing', 'No current approved workflow binding')
    return { ok: true, value: { subject, mandate } }
  }
  if (
    mandate.ok &&
    (selected.mandateRecord.repository !== mandate.value.repository ||
      selected.mandateRecord.target !== mandate.value.target ||
      selected.mandateRecord.recordId !== mandate.value.recordId)
  ) {
    return actionFailure('action-input-cycle', 'Pull request binding is not the current accounted mandate')
  }
  const binding = sourceRef(histories, { scope: pull, recordId: selected.binding.recordId, kind: 'workflow-binding' })
  if (!binding.ok) return binding
  bound = { kind: 'uw', uw: subject.uw, pullRequest: pull, binding: binding.value }
  return { ok: true, value: { subject: bound, mandate } }
}

function acceptedChain(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  mandate: Result<import('../engine/workflow-control.ts').MandateRecord>,
  config: ActionInputManifest['configuration'],
): Result<{
  spec: ActionInputManifest['spec']
  acceptedSources: RecordInputRef[]
  configuration: ActionInputManifest['configuration']
}> {
  const spec: ActionInputManifest['spec'] = { kind: 'absent', reason: 'standalone-review' }
  const acceptedSources: RecordInputRef[] = []
  if (!mandate.ok || !ACCEPTED_PURPOSE[request.purpose])
    return { ok: true, value: { spec, acceptedSources, configuration: config } }
  const accepted = resolveAcceptedSpec(mandate.value, histories)
  if (!accepted.ok) return { ok: false, diagnostics: accepted.evidence }
  const effective = resolveOwnSpecEffective(accepted.spec)
  if (!effective.ok) return { ok: false, diagnostics: effective.diagnostics }
  const pinned = pinAcceptedSources(histories, accepted.spec.sourceRefs)
  if (!pinned.ok) return pinned
  return {
    ok: true,
    value: {
      spec: { kind: 'accepted', effective: effective.value },
      acceptedSources: pinned.value,
      configuration: {
        version: mandate.value.payload.config.version,
        digest: mandate.value.payload.config.digest,
        serialized: JSON.stringify(mandate.value.payload.config.effective),
      },
    },
  }
}

function pinAcceptedSources(
  histories: readonly DecodedHistory[],
  refs: readonly ExternalRecordRef[],
): Result<RecordInputRef[]> {
  const acceptedSources: RecordInputRef[] = []
  for (const ref of refs) {
    const pinned = sourceRef(histories, ref)
    if (!pinned.ok) return pinned
    acceptedSources.push(pinned.value)
  }
  return { ok: true, value: acceptedSources }
}

async function proposedSpec(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  source: ActionFactSource,
  current: ActionInputManifest['spec'],
): Promise<Result<ActionInputManifest['spec']>> {
  if (ACCEPTED_PURPOSE[request.purpose]) return { ok: true, value: current }
  const uw = subject.uw
  const body = await source.gh(source.cwd, [
    'issue',
    'view',
    uw.target.split('#').at(-1) ?? '',
    '--repo',
    uw.repository,
    '--json',
    'body,updatedAt',
  ])
  const issue = JSON.parse(body) as { body?: string; updatedAt?: string }
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, issue.body ?? '', issue.updatedAt ?? null) })
  if (parsed.status === 'conformant') return { ok: true, value: { kind: 'proposed', uw, snapshot: parsed.snapshot } }
  if (request.purpose === 'assess-spec')
    return actionFailure('action-input-missing', 'Assessable proposed Spec is absent')
  const analysis = issueSpecAnalysisSchema.safeParse(parsed.analysis)
  if (!analysis.success) return actionFailure('action-input-missing', 'Unframed parser facts are not readable')
  return {
    ok: true,
    value: {
      kind: 'unframed',
      uw,
      source: rawSource(uw.target, issue.body ?? '', issue.updatedAt ?? null),
      parser: {
        status: parsed.status,
        diagnostics: [...parsed.diagnostics],
        analysis: analysis.data,
        draft: parsed.status === 'draft' ? parsed.draft : null,
      },
    },
  }
}

async function finishFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  subject: ActionSubject,
  spec: ActionInputManifest['spec'],
  acceptedSources: RecordInputRef[],
  mandate: Result<import('../engine/workflow-control.ts').MandateRecord>,
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  observation?: EvidenceObservation,
): Promise<Result<CurrentActionFacts>> {
  const expansion = expansionOrigin(request, histories, reviewedFingerprint)
  if (!expansion.ok) return expansion
  if (expansion.value?.workflow !== undefined) {
    const live = await validateExpandedWorkflowLive(source, request, expansion.value.workflow)
    if (!live.ok) return live
  }
  const delivery = mandate.ok
    ? selectDeliveryData(
        request,
        mandate.value,
        histories,
        (record) => authenticate(record, histories),
        expansion.value?.planner,
        spec,
      )
    : { ok: true as const, value: [] }
  if (!delivery.ok) return delivery
  const basis = await resolveEvidenceBasis(delivery.value, source, observation)
  if (!basis.ok) return basis
  const closed = assertCurrentOutputClosure(
    request,
    histories,
    [...acceptedSources, ...delivery.value],
    reviewedFingerprint,
    expansion.value?.root,
  )
  if (!closed.ok) return closed
  return {
    ok: true,
    value: {
      spec,
      subject,
      acceptedSources,
      deliveryData: delivery.value,
      currentOutputs: currentRootOutputRefs(request, histories, reviewedFingerprint, expansion.value?.root),
      configuration: config,
      ...(expansion.value?.previous === undefined ? {} : { expansionPrevious: expansion.value.previous }),
    },
  }
}

export async function uwFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  observed: { branch: string; baseName: string },
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  histories?: readonly DecodedHistory[],
  observation?: EvidenceObservation,
): Promise<Result<CurrentActionFacts>> {
  if (request.subject.kind !== 'uw') return actionFailure('action-input-missing', 'UW subject is absent')
  const subject = request.subject
  const pull = subject.pullRequest
  const read =
    histories === undefined
      ? await readHistories(pull === null ? [subject.uw] : [subject.uw, pull], source)
      : { ok: true as const, value: histories }
  if (!read.ok) return read
  const bound = bindSubject(request, subject, read.value, observed)
  if (!bound.ok) return bound
  const accepted = acceptedChain(request, read.value, bound.value.mandate, config)
  if (!accepted.ok) return accepted
  const spec = await proposedSpec(request, subject, source, accepted.value.spec)
  if (!spec.ok) return spec
  return finishFacts(
    request,
    source,
    read.value,
    bound.value.subject,
    spec.value,
    accepted.value.acceptedSources,
    bound.value.mandate,
    accepted.value.configuration,
    reviewedFingerprint,
    observation ?? seedEvidenceObservation(read.value),
  )
}

export async function readProductionActionFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  reviewedFingerprint?: string,
): Promise<Result<CurrentActionFacts>> {
  const observed = await observeCode(request, source).catch((error: unknown) =>
    actionFailure('action-code-moved', error instanceof Error ? error.message : 'code observation failed'),
  )
  if (!observed.ok) return observed
  const config = await configuration(source.cwd, request.code.referenceCommit)
  if (!config.ok) return config
  if (request.subject.kind === 'standalone-pr')
    return standaloneFacts(request, source, observed.value, config.value, reviewedFingerprint)
  return uwFacts(request, source, observed.value, config.value, reviewedFingerprint)
}
