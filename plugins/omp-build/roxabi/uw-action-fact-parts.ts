import {
  issueSpecAnalysisSchema,
  parseIssueSpecBody,
  rawSource,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { ACCEPTED_PURPOSE, acceptedChain, bindSubject } from './uw-action-accepted-state.ts'
import {
  type EvidenceObservation,
  type ObserveCausalFacts,
  resolveEvidenceBasis,
  seedEvidenceObservation,
} from './uw-action-basis.ts'
import { causeActionData } from './uw-action-cause-data.ts'
import type {
  ActionInputManifest,
  ActionSubject,
  CurrentActionFacts,
  RecordInputRef,
  ReviewRootRef,
  UwActionRequest,
} from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import { type ActionFactSource, authenticate, configuration, observeCode, readHistories } from './uw-action-observe.ts'
import { observeActionOperands } from './uw-action-operands.ts'
import { actionFailure } from './uw-action-result.ts'
import { authenticateReviewRoot } from './uw-action-review-root.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs, selectDeliveryData } from './uw-action-selection.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'

export type { ActionFactSource }

async function proposedSpec(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  source: ActionFactSource,
  current: ActionInputManifest['spec'],
): Promise<Result<ActionInputManifest['spec']>> {
  if (ACCEPTED_PURPOSE[request.purpose] || request.purpose === 'assess-spec') return { ok: true, value: current }
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
  catalogues: ReviewClassCatalogues,
  subject: ActionSubject,
  spec: ActionInputManifest['spec'],
  acceptedSources: RecordInputRef[],
  mandate: Result<import('../engine/workflow-control.ts').MandateRecord>,
  operands: CurrentActionFacts['operands'],
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  observation?: EvidenceObservation,
  reviewedRoot?: ReviewRootRef,
): Promise<Result<CurrentActionFacts>> {
  const authenticated = authenticateReviewRoot(request, histories, reviewedFingerprint, reviewedRoot, subject)
  if (!authenticated.ok) return authenticated
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
        catalogues,
        (record) => authenticate(record, histories),
        expansion.value?.planner,
        spec,
        reviewedFingerprint,
      )
    : { ok: true as const, value: { refs: [], plannedPaths: [] } }
  if (!delivery.ok) return delivery
  const currentOutputs = currentRootOutputRefs(request, histories, reviewedRoot, expansion.value?.root)
  const causes = causeActionData(request, histories, currentOutputs, catalogues)
  if (!causes.ok) return causes
  const deliveryData = [...delivery.value.refs, ...causes.value]
  const basis = await resolveEvidenceBasis(deliveryData, source, observation)
  if (!basis.ok) return basis
  const closed = assertCurrentOutputClosure(
    request,
    histories,
    catalogues,
    [...acceptedSources, ...deliveryData],
    reviewedRoot,
    expansion.value?.root,
  )
  if (!closed.ok) return closed
  return {
    ok: true,
    value: {
      spec,
      subject,
      acceptedSources,
      deliveryData,
      plannedPaths: delivery.value.plannedPaths,
      ...(operands === undefined ? {} : { operands }),
      currentOutputs,
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
  observeCausal?: ObserveCausalFacts,
  reviewedRoot?: ReviewRootRef,
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
  const replay =
    request.purpose === 'assess-spec' && reviewedFingerprint !== undefined
      ? { actionId: request.actionId, fingerprint: reviewedFingerprint }
      : undefined
  const accepted = acceptedChain(request, read.value, bound.value.mandate, config, replay)
  if (!accepted.ok) return accepted
  const spec = await proposedSpec(request, subject, source, accepted.value.spec)
  if (!spec.ok) return spec
  const operands = await observeActionOperands(request, source, read.value, accepted.value.acceptedSpec, replay)
  if (!operands.ok) return operands
  const sources = [...accepted.value.acceptedSources, ...operands.value.identitySources]
  const uniqueSources = [...new Map(sources.map((ref) => [JSON.stringify([ref.record, ref.selector]), ref])).values()]
  const observedCausal =
    observeCausal === undefined
      ? await (async () => {
          const closure = await readCauseHistoryClosure(read.value, (scopes) =>
            readComposedWorkflowHistory(scopes, source),
          )
          if (!closure.ok) return { ok: false as const, diagnostics: closure.diagnostics }
          const catalogues = await loadReviewClassCatalogues({
            histories: closure.histories,
            cwd: source.cwd,
            gh: source.gh,
          })
          return {
            ok: true as const,
            value: {
              causal: { histories: closure.histories, catalogues },
              evidence: seedEvidenceObservation(closure.histories),
            },
          }
        })()
      : await observeCausal()
  if (!observedCausal.ok) return observedCausal
  return finishFacts(
    request,
    source,
    observedCausal.value.causal.histories,
    observedCausal.value.causal.catalogues,
    bound.value.subject,
    spec.value,
    uniqueSources,
    bound.value.mandate,
    operands.value.operands,
    accepted.value.configuration,
    reviewedFingerprint,
    observedCausal.value.evidence,
    reviewedRoot,
  )
}

export async function readProductionActionFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  reviewedFingerprint?: string,
  reviewedRoot?: ReviewRootRef,
): Promise<Result<CurrentActionFacts>> {
  const observed = await observeCode(request, source).catch((error: unknown) =>
    actionFailure('action-code-moved', error instanceof Error ? error.message : 'code observation failed'),
  )
  if (!observed.ok) return observed
  const config = await configuration(source.cwd, request.code.referenceCommit)
  if (!config.ok) return config
  if (request.subject.kind === 'standalone-pr')
    return standaloneFacts(request, source, observed.value, config.value, reviewedFingerprint, undefined, reviewedRoot)
  return uwFacts(request, source, observed.value, config.value, reviewedFingerprint, undefined, undefined, reviewedRoot)
}
