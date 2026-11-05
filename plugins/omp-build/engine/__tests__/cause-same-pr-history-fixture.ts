import { TOOLING_COMMIT } from '../../skills/feature/review-record-pin.js'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { assessCauseDispositions } from '../cause-disposition.ts'
import type { CauseContext } from '../finding-target.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { resolveOwnSpecEffective } from '../spec-effective.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { withPinnedCatalogue } from './cause-catalogue-fixture.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { lineageFixture } from './cause-lineage-fixture.ts'
import { attachSamePrCriterionReview, createSamePrCriterionFixture } from './same-pr-criterion-fixture.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

export function scenario(kind: 'editorial' | 'material', priorReviews: number) {
  const initial = lineageFixture(1, false, TOOLING_COMMIT)
  const originalDisposition = initial.transitions[0]?.pending
  if (!originalDisposition) throw new Error('Expected initial disposition')
  const oldReview = recordsOf(initial.source).find((record) => record.kind === 'review')
  const binding = recordsOf(initial.source).find((record) => record.kind === 'workflow-binding')
  if (oldReview?.kind !== 'review' || binding?.kind !== 'workflow-binding')
    throw new Error('Expected authenticated review and binding')
  const boundOldReview = must(
    parseRecord({ ...oldReview, payload: { ...oldReview.payload, causeDispositionRefs: [ref(originalDisposition)] } }),
  )
  let source: DecodedHistory = {
    ...initial.source,
    operations: initial.source.operations.map((entry) =>
      entry.recordId === oldReview.recordId ? operation(boundOldReview) : entry,
    ),
  }
  const makeProof = (context: CauseContext, head?: string) =>
    createSamePrCriterionFixture({
      mandate: initial.mandate,
      effective: context.effective,
      binding,
      pullRequest: source.source.scope,
      head: head ?? initial.inputs.manifest.code.head,
      prefix: `same-pr-${context.effective.own.version.slice(0, 12)}-${(head ?? initial.inputs.manifest.code.head).slice(0, 12)}`,
    })
  const initialProof = makeProof(initial.context)
  let own = appendAccountedRecords(initial.own, initialProof.authorityRecords)
  const reviewInputs = (_prefix: string, context: CauseContext, head?: string) => {
    const proof = makeProof(context, head)
    const historicalPin = {
      source: 'record' as const,
      record: ref(initial.pending),
      selector: '/payload',
      role: 'cause-state' as const,
      digest: canonicalValueDigest(initial.pending.payload),
    }
    const manifest = {
      ...proof.inputs.manifest,
      spec: { kind: 'accepted' as const, effective: context.effective },
      plugin: initial.inputs.manifest.plugin,
      repositoryReferences: initial.inputs.manifest.repositoryReferences,
      code:
        head === undefined
          ? initial.inputs.manifest.code
          : { ...initial.inputs.manifest.code, head, referenceCommit: head },
      deliveryData:
        context.effective.own.version === initial.context.effective.own.version
          ? proof.inputs.manifest.deliveryData
          : [...proof.inputs.manifest.deliveryData, historicalPin],
    }
    return withPinnedCatalogue({ ...proof.inputs, manifest, fingerprint: actionInputDigest(manifest) })
  }
  source = attachSamePrCriterionReview(
    source,
    oldReview.recordId,
    reviewInputs('initial', initial.context),
    initialProof.verdict,
  )
  const capturedInitialDecision = recordsOf(source).find((record) => record.recordId === initial.decision.recordId)
  if (capturedInitialDecision?.kind !== 'decision') throw new Error('Expected captured initial decision')
  const addReview = (prefix: string, context: CauseContext, head?: string) => {
    const inputs = reviewInputs(prefix, context, head)
    const proof = makeProof(context, head)
    if (!recordsOf(own).some((record) => record.recordId === proof.implementationResult.recordId))
      own = appendAccountedRecords(own, proof.authorityRecords)
    const baseGraph = acceptedPullRequestReviewGraph({
      mandate: initial.mandate,
      binding,
      prefix,
      label: 'issue',
      inputs,
    })
    const captured = attachSamePrCriterionReview(baseGraph.history, baseGraph.review.recordId, inputs, proof.verdict)
    const capturedDecision = recordsOf(captured).find((record) => record.recordId === baseGraph.decision.recordId)
    const capturedReview = recordsOf(captured).find((record) => record.recordId === baseGraph.review.recordId)
    if (capturedDecision?.kind !== 'decision' || capturedReview?.kind !== 'review')
      throw new Error('Expected captured review decision and final review')
    const graph = { ...baseGraph, decision: capturedDecision, review: capturedReview }
    source = {
      ...source,
      operations: [...source.operations, ...captured.operations.filter((entry) => entry.recordId !== binding.recordId)],
    }
    const assessment = must(
      assessCauseDispositions({
        context,
        source: { kind: 'decision', decision: graph.decision },
        histories: [own, source],
        adjudications: [],
        catalogues: initial.catalogues,
      }),
    )
    const dispositions = assessment.outcomes.map((payload, index) =>
      must(
        buildRecord({
          version: 1,
          ...context.original,
          recordId: `${prefix}-disposition-${index}`,
          runId: 'same-pr',
          operationId: `${prefix}-write-${index}`,
          kind: 'cause-disposition',
          payload,
        }),
      ),
    )
    own = appendAccountedRecords(own, dispositions)
    const review = must(
      parseRecord({
        ...graph.review,
        payload: { ...graph.review.payload, causeDispositionRefs: dispositions.map(ref) },
      }),
    )
    source = {
      ...source,
      operations: source.operations.map((entry) =>
        entry.recordId === graph.review.recordId ? operation(review) : entry,
      ),
    }
    return { graph, inputs, review }
  }
  for (let index = 1; index < priorReviews; index++) addReview(`old-review-${index}`, initial.context)
  const accepted = mandateAssessmentState(initial.mandate)
  const proposed = proposedAssessmentState(accepted, { body: `Accepted ${kind} change` })
  const amendment = assessFixture(initial.mandate, `same-pr-${kind}`, accepted, proposed, kind)
  const suffix = [amendment.start, amendment.result]
  if (kind === 'material') suffix.push(acceptMaterialFixture(initial.mandate, 'same-pr-material-accept', amendment))
  own = appendAccountedRecords(own, suffix)
  const current = resolveAcceptedSpec(initial.mandate, [own, source])
  if (!current.ok) throw new Error('Expected accepted Spec B')
  const context = { original: initial.context.original, effective: must(resolveOwnSpecEffective(current.spec)) }
  return {
    initial: { ...initial, decision: capturedInitialDecision },
    originalDisposition,
    source: () => source,
    own: () => own,
    context,
    addReview,
    reviewInputs,
  }
}
