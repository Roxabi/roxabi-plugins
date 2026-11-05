import { expect, it } from 'vitest'
import { causeActionData } from '../../roxabi/uw-action-cause-data.ts'
import { currentRootOutputRefs } from '../../roxabi/uw-action-closure.ts'
import type { UwActionRequest } from '../../roxabi/uw-action-contract.ts'
import { criterionImplementationRecords } from '../../testing/criterion-accepted-plan.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import {
  assessCauseDispositions,
  effectiveRejectedFindingIds,
  resolveAdjudicationContext,
} from '../cause-disposition.ts'
import { assessCauseHolds } from '../cause-hold.ts'
import { assessCriterionReview, evidenceDigest } from '../criterion-admission.ts'
import { criterionDeclarationSchema } from '../criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../criterion-verdict-schema.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { scenario } from './cause-same-pr-history-fixture.ts'
import { attachSamePrCriterionReview } from './same-pr-criterion-fixture.ts'
import { must } from './workflow-test-support.ts'

it.each(['editorial', 'material'] as const)(
  'captures the complete resolved A lineage for a fresh independently supported %s B review',
  (classification) => {
    const state = scenario(classification, 1)
    const transition = state.initial.transitions[0]
    if (!transition) throw new Error('Expected motivated historical adjudication')
    expect(transition.pending.payload.outcome.state).toBe('pending-blocking')
    expect(transition.next.payload.outcome).toMatchObject({ state: 'final', disposition: 'report' })
    expect(transition.next.payload.previous).toEqual(ref(transition.pending))
    expect(transition.next.payload.adjudication).toEqual(ref(transition.operation))

    const sourceA = state.source()
    const ownA = state.own()
    const inputsB = state.reviewInputs('lineage-B', state.context)
    const request: UwActionRequest = {
      actionId: 'lineage-B-root',
      purpose: 'review',
      subject: inputsB.manifest.subject,
      code: inputsB.manifest.code,
      stageSources: [],
      expandedContext: [],
    }
    const historiesA = [ownA, sourceA]
    const selected = causeActionData(
      request,
      historiesA,
      currentRootOutputRefs(request, historiesA),
      state.initial.catalogues,
    )
    expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true })
    const pins = must(selected)
    expect(pins.map((pin) => pin.record.recordId).sort()).toEqual(
      [transition.pending.recordId, transition.operation.recordId, transition.next.recordId].sort(),
    )

    const accepted = resolveAcceptedSpec(state.initial.mandate, historiesA)
    if (!accepted.ok) throw new Error('Expected accepted Spec B')
    const implementationRecords = criterionImplementationRecords(
      state.initial.mandate,
      inputsB.manifest.code.head,
      accepted.spec,
    )
    const implementation = implementationRecords.find(
      (record) =>
        record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
    )
    if (
      implementation?.kind !== 'action-receipt' ||
      implementation.payload.action !== 'implement' ||
      implementation.payload.phase !== 'result' ||
      implementation.payload.structured === null
    )
      throw new Error('Expected implementation result')
    const declaration = criterionDeclarationSchema.parse(implementation.payload.structured.criteria[0])
    if (declaration?.verification !== 'evidence' || declaration.evidence[0] === undefined)
      throw new Error('Expected supported implementation criterion')
    const evidence = declaration.evidence[0]
    const evidenceRef = { receipt: ref(implementation), evidenceId: evidence.id, digest: evidenceDigest(evidence) }
    const verdict = criterionVerdictSchema.parse({
      target: declaration.target,
      verdict: 'satisfied',
      criterionKind: 'behavior',
      bugRegression: false,
      restoration: 'not-applicable',
      examined: [
        {
          evidence: evidenceRef,
          truth: 'supported',
          applicability: 'applies',
          codeLink: {
            method: 'test',
            after: { support: 'supported', reason: 'Candidate test passed', references: [] },
            before: null,
          },
          reason: 'Independent review supports the captured test',
        },
      ],
      reason: 'The accepted criterion is supported by the implementation test',
    })
    expect(
      assessCriterionReview({
        spec: state.context.effective,
        code: { repository: inputsB.manifest.code.repository, commit: inputsB.manifest.code.head },
        declarations: [declaration],
        verdicts: [verdict],
        evidence: [{ ref: evidenceRef, value: evidence }],
      }),
    ).toMatchObject({ complete: true, requiresChanges: false, diagnostics: [] })
    const implementationPin = {
      source: 'record' as const,
      role: 'implementation' as const,
      record: ref(implementation),
      selector: '/payload/structured/criteria/0',
      digest: canonicalValueDigest(declaration),
    }
    const manifest = { ...inputsB.manifest, deliveryData: [implementationPin, ...pins] }
    const inputs = { ...inputsB, manifest, fingerprint: actionInputDigest(manifest) }
    const binding = recordsOf(sourceA).find((record) => record.kind === 'workflow-binding')
    if (binding?.kind !== 'workflow-binding') throw new Error('Expected PR binding')
    const graph = acceptedPullRequestReviewGraph({
      mandate: state.initial.mandate,
      binding,
      prefix: 'lineage-B',
      label: 'issue',
      inputs,
    })
    const captured = attachSamePrCriterionReview(graph.history, graph.review.recordId, inputs, verdict)
    const decision = recordsOf(captured).find((record) => record.recordId === graph.decision.recordId)
    if (decision?.kind !== 'decision') throw new Error('Expected captured B decision')
    const source = {
      ...sourceA,
      operations: [
        ...sourceA.operations,
        ...captured.operations.filter((entry) => entry.recordId !== binding.recordId),
      ],
    }
    const own = appendAccountedRecords(ownA, implementationRecords)
    const histories = [own, source]
    for (const omitted of [transition.pending.recordId, transition.operation.recordId]) {
      const incompleteManifest = {
        ...manifest,
        deliveryData: manifest.deliveryData.filter((pin) => pin.record.recordId !== omitted),
      }
      const incomplete = { ...inputs, manifest: incompleteManifest, fingerprint: actionInputDigest(incompleteManifest) }
      expect(
        effectiveRejectedFindingIds({
          decision,
          action: incomplete,
          histories,
          catalogues: state.initial.catalogues,
        }).ok,
      ).toBe(false)
    }
    const unresolvedOwn = {
      ...own,
      operations: own.operations.filter(
        (entry) => entry.recordId !== transition.operation.recordId && entry.recordId !== transition.next.recordId,
      ),
    }
    const unresolvedManifest = {
      ...manifest,
      deliveryData: manifest.deliveryData.filter(
        (pin) => pin.role !== 'cause-state' || pin.record.recordId === transition.pending.recordId,
      ),
    }
    const unresolvedInput = {
      ...inputs,
      manifest: unresolvedManifest,
      fingerprint: actionInputDigest(unresolvedManifest),
    }
    expect(
      effectiveRejectedFindingIds({
        decision,
        action: unresolvedInput,
        histories: [unresolvedOwn, source],
        catalogues: state.initial.catalogues,
      }).ok,
    ).toBe(false)
    const selectedRejections = effectiveRejectedFindingIds({
      decision,
      action: inputs,
      histories,
      catalogues: state.initial.catalogues,
    })
    expect(selectedRejections, JSON.stringify(selectedRejections)).toEqual({ ok: true, value: [] })
    const assessment = assessCauseDispositions({
      context: state.context,
      source: { kind: 'decision', decision },
      histories,
      adjudications: [],
      catalogues: state.initial.catalogues,
    })
    expect(assessment, JSON.stringify(assessment)).toMatchObject({ ok: true })
  },
)

it.each(['editorial', 'material'] as const)(
  'keeps an unresolved historical A cause on hold after accepted %s B',
  (classification) => {
    const state = scenario(classification, 1)
    const transition = state.initial.transitions[0]
    if (!transition) throw new Error('Expected historical cause')
    const own = {
      ...state.own(),
      operations: state
        .own()
        .operations.filter(
          (entry) => entry.recordId !== transition.operation.recordId && entry.recordId !== transition.next.recordId,
        ),
    }
    const histories = [own, state.source()]
    expect(resolveAcceptedSpec(state.initial.mandate, histories)).toMatchObject({ ok: true })
    const origin = resolveAdjudicationContext({
      pending: transition.pending,
      histories,
      catalogues: state.initial.catalogues,
    })
    expect(origin, JSON.stringify(origin)).toEqual({ ok: true, value: state.initial.context })
    const forged = {
      ...transition.pending,
      payload: {
        ...transition.pending.payload,
        origin: { ...transition.pending.payload.origin, version: '0'.repeat(64) },
      },
    }
    expect(resolveAdjudicationContext({ pending: forged, histories, catalogues: state.initial.catalogues }).ok).toBe(
      false,
    )
    const acceptedRecord = recordsOf(own).find(
      (record) => record.recordId === state.context.effective.own.sourceAccepted.recordId,
    )
    if (!acceptedRecord) throw new Error('Expected authenticated B continuation')
    const missingResult =
      acceptedRecord.kind === 'operator-control' && acceptedRecord.payload.control === 'accept-material'
        ? acceptedRecord.payload.assessment.recordId
        : acceptedRecord.recordId
    const missingB = {
      ...own,
      operations: own.operations.filter((entry) => entry.recordId !== missingResult),
    }
    expect(
      resolveAdjudicationContext({
        pending: transition.pending,
        histories: [missingB, state.source()],
        catalogues: state.initial.catalogues,
      }).ok,
    ).toBe(false)
    const holds = assessCauseHolds({
      uw: state.context.original,
      histories,
      catalogues: state.initial.catalogues,
      graph: { status: 'complete', root: state.context.original, nodes: [], observedAt: '2026-10-27T12:00:00.000Z' },
    })
    expect(holds).toContainEqual(
      expect.objectContaining({ code: 'cause-adjudication-required', recordId: transition.pending.recordId }),
    )
  },
)
