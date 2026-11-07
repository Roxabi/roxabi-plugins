import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { causeActionData } from '../../roxabi/uw-action-cause-data.ts'
import { currentRootOutputRefs } from '../../roxabi/uw-action-closure.ts'
import type { UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { TOOLING_COMMIT } from '../../skills/feature/review-record-pin.js'
import { causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { assessCauseDispositions } from '../cause-disposition.ts'
import type { CauseContext } from '../finding-target.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { isAssessResult } from '../workflow-spec-assessment.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { lineageFixture, lineageSeed } from './cause-lineage-fixture.ts'
import {
  attachSamePrCriterionReview,
  createSamePrCriterionFixture,
  type SamePrCriterionFixture,
  type SamePrCriterionFixtureOptions,
} from './same-pr-criterion-fixture.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { must } from './workflow-test-support.ts'

export async function scenario(
  kind: 'editorial' | 'material',
  priorReviews: number,
  native: {
    baseHead: string
    initialHead: string
    currentHead: string
    produce(context: {
      mandate: SamePrCriterionFixtureOptions['mandate']
      effective: SamePrCriterionFixtureOptions['effective']
      binding: SamePrCriterionFixtureOptions['binding']
      pullRequest: SamePrCriterionFixtureOptions['pullRequest']
      head: string
      prefix: string
      histories: readonly DecodedHistory[]
      nativeBody: string
    }): Promise<{ records: CanonicalRecord[]; history: DecodedHistory; reviewInputs: ActionInputs }>
  },
) {
  const seed = lineageSeed(TOOLING_COMMIT, native.baseHead)
  let nativeBody = seed.body
  const initialPrefix = `same-pr-${seed.context.effective.own.version.slice(0, 12)}-${native.initialHead.slice(0, 12)}`
  const initialOptions = {
    mandate: seed.mandate,
    effective: seed.context.effective,
    binding: seed.binding,
    pullRequest: seed.graph.history.source.scope,
    head: native.initialHead,
    prefix: initialPrefix,
  }
  const initialProof = await createSamePrCriterionFixture({
    ...initialOptions,
    produce: () => native.produce({ ...initialOptions, histories: seed.histories, nativeBody }),
  })
  const initial = lineageFixture(1, false, TOOLING_COMMIT, {
    inputs: initialProof.inputs,
    verdict: initialProof.verdict,
    authorityHistory: initialProof.authorityHistory,
    lineageHead: native.baseHead,
  })
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
  const proofs = new Map<string, SamePrCriterionFixture>()
  proofs.set(`${canonicalValueDigest(initial.context.effective.own)}:${native.initialHead}`, initialProof)
  const makeProof = async (context: CauseContext, head?: string) => {
    const isInitial =
      canonicalValueDigest(context.effective.own) === canonicalValueDigest(initial.context.effective.own)
    const candidate = head ?? (isInitial ? native.initialHead : native.currentHead)
    const key = `${canonicalValueDigest(context.effective.own)}:${candidate}`
    const existing = proofs.get(key)
    if (existing) return existing
    const prefix = `same-pr-${context.effective.own.version.slice(0, 12)}-${candidate.slice(0, 12)}`
    const options = {
      mandate: initial.mandate,
      effective: context.effective,
      binding,
      pullRequest: source.source.scope,
      head: candidate,
      prefix,
    }
    const proof = await createSamePrCriterionFixture({
      ...options,
      produce: () => native.produce({ ...options, histories: [own, source], nativeBody }),
    })
    const observed = new Map(recordsOf(proof.authorityHistory).map((record) => [record.recordId, record]))
    for (const record of recordsOf(own)) {
      const persisted = observed.get(record.recordId)
      if (!persisted || canonicalValueDigest(persisted) !== canonicalValueDigest(record))
        throw new Error(`Native readback lost prior authority ${record.recordId}`)
    }
    own = proof.authorityHistory
    proofs.set(key, proof)
    return proof
  }
  let own = initial.own
  const reviewInputs = async (prefix: string, context: CauseContext, head?: string) => {
    const proof = await makeProof(context, head)
    const request: UwActionRequest = {
      actionId: `${prefix}-root`,
      purpose: 'review',
      subject: proof.inputs.manifest.subject,
      code: proof.inputs.manifest.code,
      stageSources: [],
      expandedContext: [],
    }
    const histories = [own, source]
    const historicalPins =
      canonicalValueDigest(context.effective.own) === canonicalValueDigest(initial.context.effective.own)
        ? []
        : must(causeActionData(request, histories, currentRootOutputRefs(request, histories), initial.catalogues))
    for (const pin of historicalPins) {
      if (!proof.inputs.manifest.deliveryData.some((item) => canonicalValueDigest(item) === canonicalValueDigest(pin)))
        throw new Error('Prepared review inputs omit historical cause closure')
    }
    return proof.inputs
  }
  const capturedInitialDecision = recordsOf(source).find((record) => record.recordId === initial.decision.recordId)
  if (capturedInitialDecision?.kind !== 'decision') throw new Error('Expected captured initial decision')
  const addReview = async (prefix: string, context: CauseContext, head?: string) => {
    const inputs = await reviewInputs(prefix, context, head)
    const proof = await makeProof(context, head)
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
        capture: synthesisActionCapture(graph.decision, [source]),
        graph: causeFixtureGraph(nativeBody),
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
  for (let index = 1; index < priorReviews; index++) await addReview(`old-review-${index}`, initial.context)
  const accepted = mandateAssessmentState(initial.mandate)
  const currentContent = accepted.snapshot.spec
  const changedContent = must(
    canonicalSpec({
      ...currentContent,
      criteria:
        kind === 'material'
          ? currentContent.criteria.map((criterion) => ({ ...criterion, statement: 'Accepted material change' }))
          : currentContent.criteria,
    }),
  )
  nativeBody = `${renderIssueSpecBody(changedContent, { complexity: 1 })}${kind === 'editorial' ? '\n' : ''}`
  const parsed = parseIssueSpecBody({
    uw: initial.context.original,
    raw: rawSource(initial.context.original.target, nativeBody, '2026-10-27T12:00:00.000Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec B')
  const proposed = { ...proposedAssessmentState(accepted, { body: nativeBody }), snapshot: parsed.snapshot }
  const draft = assessFixture(initial.mandate, `same-pr-${kind}`, accepted, proposed, kind, [own, source])
  const bindAssessment = (record: CanonicalRecord) => {
    if (record.kind !== 'action-receipt' || record.payload.action !== 'assess-spec')
      throw new Error('Expected Spec assessment receipt')
    const previous = record.payload.inputs
    const manifest = {
      ...previous.manifest,
      code: {
        repository: initial.context.original.repository,
        base: native.baseHead,
        head: native.initialHead,
        referenceCommit: native.initialHead,
      },
    }
    return must(
      buildRecord({
        ...record,
        payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
      }),
    )
  }
  const result = bindAssessment(draft.result)
  if (!isAssessResult(result)) throw new Error('Expected bound Spec assessment result')
  const amendment = { ...draft, start: bindAssessment(draft.start), result }
  const suffix: CanonicalRecord[] = [amendment.start, amendment.result]
  if (kind === 'material') suffix.push(acceptMaterialFixture(initial.mandate, 'same-pr-material-accept', amendment))
  own = appendAccountedRecords(own, suffix)
  const current = resolveAcceptedSpec(initial.mandate, [own, source])
  if (!current.ok) throw new Error('Expected accepted Spec B')
  const context = {
    original: initial.context.original,
    effective: must(
      resolveSpecEffective({
        mode: 'historical',
        own: current.spec.ref,
        versionVector: [current.spec.ref, ...current.spec.inheritedOwnSpecRefs],
        histories: [own, source],
      }),
    ),
  }
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
