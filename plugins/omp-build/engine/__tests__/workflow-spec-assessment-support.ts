import { sourceRef } from '../../roxabi/uw-action-observe.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { acceptedMetadataOwner } from '../accepted-metadata-owner.ts'
import { canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { equalScope, sameOwnSpecRef } from '../record-diagnostics.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { resolveSpecEffective } from '../spec-effective.ts'
import { recordRef } from '../uw-delivery-review.ts'
import type { SpecContent, UwTier } from '../uw-spec.ts'
import type { OwnSpecRef } from '../uw-spec-schema.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecAt } from '../workflow-accepted-spec.ts'
import { capturedChildOwnSources } from '../workflow-assessment-child-sources.ts'
import { acceptedConstraints, proposedConstraints } from '../workflow-constraint-compatibility.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { historyFor, mandatesOf } from '../workflow-control.ts'
import type { SpecAssessment } from '../workflow-output-schema.ts'
import { ACTION_RECEIPT_FORMAT, type AssessSpecExact } from '../workflow-receipt-schema.ts'
import { type AssessResultRecord, isAssessResult } from '../workflow-spec-assessment.ts'
import { buildShippedFeatureMandate, defaultDecisions } from './workflow-assessment-defaults.ts'
import { makeProposedAssessmentState } from './workflow-proposed-state-fixture.ts'
import { assessmentActionInputs } from './workflow-spec-assessment-input-fixtures.ts'
import { assessmentState, materialControl, materialState } from './workflow-spec-material-support.ts'
import { facts, must } from './workflow-test-support.ts'

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
    inheritedOwnSpecRefs: mandated.payload.inheritedOwnSpecRefs,
    coverage: mandated.payload.coverage,
  }
}

export function proposedAssessmentState(accepted: AssessmentState, input: ProposedStateInput): ProposedAssessmentState {
  return makeProposedAssessmentState(accepted, input)
}

export function assessFixture(
  mandated: CanonicalRecord,
  id: string,
  accepted: AssessmentState,
  proposed: ProposedAssessmentState,
  classification: 'editorial' | 'material' | 'unknown' | null,
  sources: readonly DecodedHistory[],
  native: {
    completion: 'completed' | 'error' | 'cancelled' | 'incomplete'
    strict: 'valid' | 'invalid' | 'absent'
  } = {
    completion: 'completed',
    strict: 'valid',
  },
  mandateId = mandated.recordId,
  codeRange?: ActionInputs['manifest']['code'],
): FixtureAssessment {
  if (mandated.kind !== 'mandate') throw new Error('Assessment fixture requires a mandate')
  const scope = { repository: mandated.repository, target: mandated.target }
  const mandateRef = { scope, recordId: mandateId, kind: 'mandate' as const }
  const acceptedAt = (ref: OwnSpecRef) => {
    const source = historyFor(ref.uw, sources)
    if (source === null || !source.source.complete) throw new Error(`Missing complete source for ${ref.uw.target}`)
    const matches = mandatesOf(source).flatMap((candidate) => {
      const resolved = resolveAcceptedSpecAt(candidate, sources, ref)
      return resolved.ok && sameOwnSpecRef(resolved.spec.ref, ref) ? [resolved.spec] : []
    })
    if (matches.length !== 1 || !matches[0]) throw new Error(`Cannot authenticate accepted source for ${ref.uw.target}`)
    return matches[0]
  }
  const currentOwn = resolveAcceptedSpec(mandated, sources)
  if (!currentOwn.ok) throw new Error('Current accepted parent is unavailable')
  const own = currentOwn.spec
  for (const field of ['snapshot', 'tier', 'children', 'inheritedOwnSpecRefs', 'coverage'] as const) {
    if (canonicalValueDigest(own[field]) !== canonicalValueDigest(accepted[field]))
      throw new Error(`Accepted ${field} differs from authenticated history`)
  }
  const effective = must(
    resolveSpecEffective({
      mode: 'historical',
      own: accepted.ref,
      versionVector: [accepted.ref, ...accepted.inheritedOwnSpecRefs],
      histories: sources,
    }),
  )
  const lastStep = own.chain[own.chain.length - 1]
  if (!lastStep) throw new Error('Accepted metadata chain is empty')
  const owner = must(acceptedMetadataOwner(lastStep, sources))
  const captured = capturedChildOwnSources(accepted, proposed, sources, [])
  if (captured === null) throw new Error('Child authority cannot be captured')
  const childOwnSources = captured.childOwnSources
  const inherited = [...accepted.inheritedOwnSpecRefs, ...proposed.inheritedOwnSpecRefs]
  const uniqueInherited = inherited.filter(
    (ref, index) => inherited.findIndex((prior) => sameOwnSpecRef(prior, ref)) === index,
  )
  const inheritedConstraints = uniqueInherited.flatMap((ref) =>
    acceptedConstraints(ref, acceptedAt(ref).snapshot.spec, false),
  )
  const engaged = accepted.children.flatMap((child, index) => {
    const declared = childOwnSources.find((source) => equalScope(source.uw, child.scope))
    if (!declared) throw new Error('Missing accepted child source')
    if (declared.own !== null) return acceptedConstraints(declared.own, acceptedAt(declared.own).snapshot.spec, true)
    const engagement = {
      source: 'record' as const,
      record: owner.record,
      selector: `${owner.selector}/children/${index}`,
      digest: canonicalValueDigest(child),
    }
    const elements = [
      ...child.snapshot.spec.criteria.map((item) => ({ kind: 'criterion' as const, id: item.id })),
      ...child.snapshot.spec.invariants.map((item) => ({ kind: 'invariant' as const, id: item.id })),
      ...child.snapshot.spec.exclusions.map((_, index) => ({ kind: 'exclusion' as const, index })),
    ]
    return elements.map((element) => ({
      kind: 'engaged' as const,
      parent: accepted.ref,
      engagement,
      child: child.scope,
      version: child.specVersion,
      element,
    }))
  })
  const proposedChildConstraints = proposed.children.flatMap((child) => {
    if ('kind' in child)
      return proposedConstraints(accepted.ref.uw, child.plan.allocation.spec, {
        kind: 'created-by',
        operationId: child.operationId,
      })
    const previous = accepted.children.find((item) => equalScope(item.scope, child.scope))
    const changed =
      previous &&
      previous.specVersion === child.specVersion &&
      previous.tier === child.tier &&
      canonicalValueDigest(previous.snapshot.spec) === canonicalValueDigest(child.snapshot.spec)
        ? []
        : proposedConstraints(child.scope, child.snapshot.spec)
    const source = childOwnSources.find((entry) => equalScope(entry.uw, child.scope))
    return !previous && source?.own
      ? [...changed, ...acceptedConstraints(source.own, acceptedAt(source.own).snapshot.spec, true)]
      : changed
  })
  const allConstraints = [
    ...acceptedConstraints(accepted.ref, accepted.snapshot.spec, true),
    ...proposedConstraints(accepted.ref.uw, proposed.snapshot.spec),
    ...inheritedConstraints,
    ...engaged,
    ...proposedChildConstraints,
  ]
  const uniqueConstraints = [...new Map(allConstraints.map((item) => [canonicalValueDigest(item), item])).values()]
  if (!uniqueConstraints[0]) throw new Error('assessment fixture requires at least one constraint')
  const compatibility: SpecAssessment['compatibility'] = {
    state: 'consistent',
    examined: [uniqueConstraints[0], ...uniqueConstraints.slice(1)],
    references: [],
    reason: 'Fixture judgment covers the declared constraints',
  }
  const refs = [...own.sourceRefs, ...effective.versionVector.map((ref) => ref.sourceAccepted), ...captured.sourceRefs]
  const pins = refs.map((ref) => must(sourceRef(sources, ref)))
  const acceptedSources = [...new Map(pins.map((pin) => [JSON.stringify([pin.record, pin.selector]), pin])).values()]
  const { inputs, exactInputs } = assessmentActionInputs(
    mandated,
    accepted,
    proposed,
    childOwnSources,
    effective,
    acceptedSources,
    codeRange,
  )
  const start = must(
    buildRecord({
      version: 1,
      repository: scope.repository,
      target: scope.target,
      recordId: `${id}-start`,
      runId: 'run-1',
      operationId: `op-${id}-start`,
      kind: 'action-receipt',
      payload: {
        format: ACTION_RECEIPT_FORMAT,
        inputs,
        phase: 'start',
        action: 'assess-spec',
        actionId: `act-${id}`,
        mandate: mandateRef,
        exactInputs,
      },
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
        format: ACTION_RECEIPT_FORMAT,
        inputs,
        phase: 'result',
        action: 'assess-spec',
        actionId: `act-${id}`,
        mandate: mandateRef,
        start: recordRef(start),
        exactInputs,
        native: { ...native, raw: null },
        structured: classification === null ? null : { classification, compatibility },
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
  return assessmentState(assessment)
}

export function acceptMaterialFixture(
  mandated: CanonicalRecord,
  id: string,
  assessment: FixtureAssessment,
  predecessor: ExternalRecordRef = assessment.result.payload.exactInputs.accepted.ref.sourceAccepted,
) {
  return materialControl(mandated, id, assessment, predecessor)
}

export function acceptedMaterialState(assessment: FixtureAssessment, control: CanonicalRecord): AssessmentState {
  return materialState(assessment, control)
}

const workflowFixtures = roxabiWorkflowFixtures()

export function shippedFeatureMandate(): MandateRecord {
  return buildShippedFeatureMandate(workflowFixtures)
}

export function decisions() {
  return defaultDecisions()
}

export function currentFacts(mandated: MandateRecord, currentSpec: ProposedAssessmentState) {
  return facts({
    productVersion: mandated.payload.config.productVersion,
    configVersion: mandated.payload.config.version,
    configDigest: mandated.payload.config.digest,
    supportedConfigVersions: [mandated.payload.config.version],
    currentSpec,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
  })
}
