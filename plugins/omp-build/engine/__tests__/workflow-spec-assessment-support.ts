import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { canonicalSpec, type SpecContent, type SpecSnapshot, type UwTier } from '../uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../uw-spec-schema.ts'
import type { AssessSpecExact } from '../workflow-receipt-schema.ts'
import {
  type AssessResultRecord,
  isAssessResult,
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
  mechanicalSpecDelta,
} from '../workflow-spec-assessment.ts'
import { must } from './workflow-test-support.ts'

export type AssessmentState = AssessSpecExact['accepted']
export type ProposedAssessmentState = AssessSpecExact['proposed']
type FixtureAssessment = {
  start: CanonicalRecord
  result: AssessResultRecord
  proposed: ProposedAssessmentState
  currentVersion: string
  classification: 'editorial' | 'material' | 'unknown' | null
}

type ProposedStateInput = {
  body: string
  content?: Omit<SpecContent, 'format'>
  tier?: UwTier
  children?: ProposedAssessmentState['children']
}

function recordRef(record: CanonicalRecord) {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}

function snapshot(input: ProposedStateInput, reference: string): SpecSnapshot {
  const content = input.content ?? {
    criteria: [{ id: 'C1' as const, statement: input.body }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  }
  const canonical = canonicalSpec({ format: SPEC_CONTENT_FORMAT, ...content })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  return {
    spec: canonical.value,
    raw: {
      reference,
      body: input.body,
      bodySha256: specDigest(input.body),
      lastEditedAt: '2026-10-21T00:00:00Z',
    },
  }
}

export function mandateAssessmentState(mandated: CanonicalRecord): AssessmentState {
  if (mandated.kind !== 'mandate') throw new Error('Assessment fixture requires a mandate')
  return {
    ref: {
      uw: mandated.payload.ownSpec.uw,
      version: mandated.payload.ownSpec.version,
      sourceAccepted: recordRef(mandated),
    },
    snapshot: mandated.payload.ownSpec.snapshot,
    tier: mandated.payload.tier,
    children: mandated.payload.children,
  }
}

export function proposedAssessmentState(accepted: AssessmentState, input: ProposedStateInput): ProposedAssessmentState {
  return {
    snapshot: snapshot(input, accepted.snapshot.raw.reference),
    tier: input.tier ?? accepted.tier,
    children: input.children ?? accepted.children,
  }
}

function assessmentInputs(
  mandated: Extract<CanonicalRecord, { kind: 'mandate' }>,
  accepted: AssessmentState,
  proposed: ProposedAssessmentState,
) {
  return {
    format: 'omp-build-spec-assessment/2' as const,
    accepted,
    proposed,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
}

export function assessFixture(
  mandated: CanonicalRecord,
  id: string,
  accepted: AssessmentState,
  proposed: ProposedAssessmentState,
  classification: 'editorial' | 'material' | 'unknown' | null,
  native: {
    completion: 'completed' | 'error' | 'cancelled' | 'incomplete'
    strict: 'valid' | 'invalid' | 'absent'
  } = {
    completion: 'completed',
    strict: 'valid',
  },
  mandateId = mandated.recordId,
): FixtureAssessment {
  if (mandated.kind !== 'mandate') throw new Error('Assessment fixture requires a mandate')
  const scope = { repository: mandated.repository, target: mandated.target }
  const mandateRef = { scope, recordId: mandateId, kind: 'mandate' as const }
  const exactInputs = assessmentInputs(mandated, accepted, proposed)
  const start = must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `${id}-start`,
      runId: 'run-1',
      operationId: `op-${id}-start`,
      kind: 'action-receipt',
      payload: { phase: 'start', action: 'assess-spec', actionId: `act-${id}`, mandate: mandateRef, exactInputs },
    }),
  )
  const result = must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: id,
      runId: 'run-1',
      operationId: `op-${id}`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'assess-spec',
        actionId: `act-${id}`,
        mandate: mandateRef,
        start: recordRef(start),
        exactInputs,
        native: { ...native, raw: null },
        structured: classification === null ? null : { classification },
        admission: null,
        diagnostics: [],
      },
    }),
  )
  if (!isAssessResult(result)) throw new Error('Assessment fixture result is not an assessment receipt')
  return {
    start,
    result,
    proposed: exactInputs.proposed,
    currentVersion: exactInputs.proposed.snapshot.spec.version,
    classification,
  }
}

export function acceptedAssessmentState(assessment: FixtureAssessment): AssessmentState {
  return {
    ref: {
      uw: assessment.result.payload.exactInputs.accepted.ref.uw,
      version: assessment.proposed.snapshot.spec.version,
      sourceAccepted: recordRef(assessment.result),
    },
    snapshot: assessment.proposed.snapshot,
    tier: assessment.proposed.tier,
    children: assessment.proposed.children,
  }
}

export function acceptMaterialFixture(
  mandated: CanonicalRecord,
  id: string,
  assessment: FixtureAssessment,
  predecessor: AssessmentState = assessment.result.payload.exactInputs.accepted,
) {
  if (mandated.kind !== 'mandate') throw new Error('Material control fixture requires a mandate')
  const scope = { repository: mandated.repository, target: mandated.target }
  const exactInputs = assessment.result.payload.exactInputs
  const mandateRef = recordRef(mandated)
  const predecessorRef = predecessor.ref.sourceAccepted
  const assessmentRef = recordRef(assessment.result)
  if (assessment.classification !== 'material' && assessment.classification !== 'unknown')
    throw new Error('Material control fixture requires a material or unknown assessment')
  const proposal: MaterialAcceptanceProposal = {
    format: 'omp-build-material-acceptance/1',
    operationId: `op-${id}`,
    uw: assessment.result.payload.exactInputs.accepted.ref.uw,
    mandate: mandateRef,
    predecessor: predecessorRef,
    assessment: assessmentRef,
    classification: assessment.classification,
    exactInputs,
  }
  const digest = materialAcceptanceDigest(proposal)
  return must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: id,
      runId: 'run-1',
      operationId: `op-${id}`,
      kind: 'operator-control',
      payload: {
        control: 'accept-material',
        controlId: id,
        mandate: mandateRef,
        predecessor: predecessorRef,
        assessment: assessmentRef,
        specVersion: assessment.proposed.snapshot.spec.version,
        proposalDigest: digest,
        confirmation: {
          route: 'omp-native-command',
          operationId: `op-${id}`,
          proposalDigest: digest,
          confirmedAt: '2026-10-21T00:00:00Z',
        },
        identityDelta: { retired: exactInputs.mechanical.removed },
      },
    }),
  )
}

export function acceptedMaterialState(assessment: FixtureAssessment, control: CanonicalRecord): AssessmentState {
  return {
    ref: {
      uw: assessment.result.payload.exactInputs.accepted.ref.uw,
      version: assessment.proposed.snapshot.spec.version,
      sourceAccepted: recordRef(control),
    },
    snapshot: assessment.proposed.snapshot,
    tier: assessment.proposed.tier,
    children: assessment.proposed.children,
  }
}
