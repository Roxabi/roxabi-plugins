import { describe, expect, it } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { canonicalValueDigest } from '../canonical-value.ts'
import { parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import { checkAuthenticatedSpecCompatibility } from '../workflow-accepted-spec.ts'
import { actionOperandsSchema } from '../workflow-action-operands.ts'
import { capturedAssessmentSourcesMatch, capturedChildOwnSources } from '../workflow-assessment-child-sources.ts'
import { recheckComposedAssessmentDelta } from '../workflow-composed-material-preparation.ts'
import { type SpecAssessment, specAssessmentSchema } from '../workflow-output-schema.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { featureMandate, history, mandate as makeMandate, must } from './workflow-test-support.ts'

describe('exact compatibility assessment', () => {
  function assessment() {
    const mandate = featureMandate()
    const accepted = mandateAssessmentState(mandate)
    const proposed = proposedAssessmentState(accepted, { body: 'Revised bounded outcome' })
    const fixture = assessFixture(mandate, 'assessment-exact', accepted, proposed, 'editorial', [history([mandate])])
    const parsed = specAssessmentSchema.parse(fixture.result.payload.structured)
    return { mandate, fixture, parsed, histories: [history([mandate, fixture.start, fixture.result])] }
  }
  it('requires an explicit origin and rejects a cause origin without its created slot', () => {
    const { mandate, fixture } = assessment()
    const exactInputs = fixture.result.payload.exactInputs
    expect(actionOperandsSchema.safeParse({ action: 'assess-spec', exactInputs }).success).toBe(false)
    expect(
      actionOperandsSchema.safeParse({
        action: 'assess-spec',
        exactInputs,
        origin: {
          kind: 'cause-created-child',
          creation: {
            kind: 'report-promotion',
            report: {
              scope: { repository: mandate.repository, target: mandate.target },
              recordId: 'report',
              kind: 'cause-disposition',
            },
            reportDigest: 'a'.repeat(64),
            reason: 'Promote',
            parentObservation: null,
          },
        },
      }).success,
    ).toBe(false)
  })
  it('requires the explicit native wayfinder inventory in the sealed assessment', () => {
    const { fixture } = assessment()
    const exactInputs = fixture.result.payload.exactInputs
    const { attachedWayfinders: _omitted, ...incomplete } = exactInputs
    const origin = { kind: 'native-current' as const }
    expect(actionOperandsSchema.safeParse({ action: 'assess-spec', origin, exactInputs }).success).toBe(true)
    expect(actionOperandsSchema.safeParse({ action: 'assess-spec', origin, exactInputs: incomplete }).success).toBe(
      false,
    )
  })
  it('allows only the actual authenticated assessment pair and no native movement', () => {
    const { mandate, fixture } = assessment()
    const uw = { repository: mandate.repository, target: mandate.target }
    const date = '2026-10-27T12:00:00.000Z'
    const node = {
      uw,
      title: 'parent',
      raw: { reference: uw.target, body: '', bodySha256: specDigest(''), lastEditedAt: date },
      updatedAt: date,
      labels: ['size:S'],
      wayfinderLabels: [],
      parent: null,
      children: [],
      blockers: [],
      native: { state: 'OPEN' as const, stateReason: null },
    }
    const before: Extract<UwCompletionObservation, { status: 'complete' }> = {
      status: 'complete',
      root: uw,
      graph: { status: 'complete', root: uw, observedAt: date, nodes: [node] },
      histories: [history([mandate])],
      catalogues: fixtureReviewClassCatalogues(),
      delivery: [],
    }
    const after: Extract<UwCompletionObservation, { status: 'complete' }> = {
      ...before,
      histories: [history([mandate, fixture.start, fixture.result])],
    }
    const input = {
      before,
      after,
      assessment: { scope: uw, recordId: fixture.result.recordId, kind: 'action-receipt' as const },
      mandate: { scope: uw, recordId: mandate.recordId, kind: 'mandate' as const },
    }
    expect(recheckComposedAssessmentDelta(input).ok).toBe(true)
    expect(
      recheckComposedAssessmentDelta({
        ...input,
        after: { ...after, graph: { ...after.graph, nodes: [{ ...node, title: 'changed' }] } },
      }).ok,
    ).toBe(false)
  })

  it('captures a pre-mandate child only with its complete history', () => {
    const mandate = featureMandate()
    const accepted = mandateAssessmentState(mandate)
    const child = { repository: accepted.ref.uw.repository, target: `${accepted.ref.uw.repository}#918` }
    const proposed = proposedAssessmentState(accepted, {
      body: 'Parent proposal',
      children: [{ scope: child, specVersion: accepted.snapshot.spec.version, snapshot: accepted.snapshot, tier: 'S' }],
    })
    expect(capturedChildOwnSources(accepted, proposed, [], [])).toBeNull()
    expect(capturedChildOwnSources(accepted, proposed, [history([], child)], [])).toEqual({
      childOwnSources: [{ uw: child, own: null }],
      sourceRefs: [],
    })
    const incomplete = history([], child)
    expect(
      capturedChildOwnSources(
        accepted,
        proposed,
        [{ ...incomplete, source: { ...incomplete.source, complete: false } }],
        [],
      ),
    ).toBeNull()
  })

  it('captures an abandoned managed child only with its exact historical authority and pinned abandonment', () => {
    const parent = mandateAssessmentState(featureMandate())
    const childScope = { repository: parent.ref.uw.repository, target: `${parent.ref.uw.repository}#918` }
    const child = makeMandate({ scope: childScope, recordId: 'managed-child' })
    if (child.kind !== 'mandate') throw new Error('expected child mandate')
    const commitment = {
      scope: childScope,
      snapshot: child.payload.ownSpec.snapshot,
      specVersion: child.payload.ownSpec.version,
      tier: child.payload.tier,
    }
    const accepted = { ...parent, children: [commitment] }
    const proposed = {
      snapshot: parent.snapshot,
      tier: parent.tier,
      children: [],
      inheritedOwnSpecRefs: parent.inheritedOwnSpecRefs,
      coverage: null,
    }
    const abandon = must(
      parseRecord({
        version: 1,
        repository: childScope.repository,
        target: childScope.target,
        recordId: 'abandon-child',
        runId: 'run-1',
        operationId: 'abandon-child-op',
        kind: 'operator-control',
        inputs: [child.recordId],
        payload: {
          control: 'abandon',
          controlId: 'abandon-child',
          predecessor: null,
          mandate: { scope: childScope, recordId: child.recordId, kind: 'mandate' },
        },
      }),
    )
    expect(capturedChildOwnSources(accepted, proposed, [history([child], childScope)], [])).toBeNull()
    const full = history([child, abandon], childScope)
    const captured = capturedChildOwnSources(accepted, proposed, [full], [])
    expect(captured?.childOwnSources).toEqual([
      {
        uw: childScope,
        own: {
          uw: childScope,
          version: commitment.specVersion,
          sourceAccepted: { scope: childScope, kind: 'mandate', recordId: child.recordId },
        },
      },
    ])
    expect(captured?.sourceRefs).toContainEqual({
      scope: childScope,
      kind: 'operator-control',
      recordId: abandon.recordId,
    })
    if (captured === null) throw new Error('expected authenticated abandoned child')
    const pins = captured.sourceRefs.map((ref) => {
      const operation = full.operations.find((item) => item.recordId === ref.recordId && item.kind === ref.kind)
      if (!operation?.record) throw new Error('missing captured record')
      return {
        source: 'record' as const,
        record: ref,
        selector: '/payload',
        digest: canonicalValueDigest(operation.record.payload),
      }
    })
    expect(capturedAssessmentSourcesMatch(captured, pins, [full])).toBe(true)
    expect(
      capturedAssessmentSourcesMatch(
        captured,
        pins.filter((pin) => pin.record.recordId !== abandon.recordId),
        [full],
      ),
    ).toBe(false)
    expect(capturedChildOwnSources(accepted, { ...proposed, children: [commitment] }, [full], [])).toBeNull()
    expect(
      capturedChildOwnSources(accepted, proposed, [{ ...full, source: { ...full.source, complete: false } }], []),
    ).toBeNull()
    const competitor = must(
      parseRecord({
        ...child,
        recordId: 'other-mandate',
        operationId: 'other-mandate-op',
        payload: { ...child.payload, tier: child.payload.tier === 'S' ? 'F-lite' : 'S' },
      }),
    )
    const otherAbandon = must(
      parseRecord({
        ...abandon,
        recordId: 'other-abandon',
        operationId: 'other-abandon-op',
        inputs: [competitor.recordId],
        payload: {
          control: 'abandon',
          controlId: 'other-abandon',
          predecessor: null,
          mandate: { scope: childScope, recordId: competitor.recordId, kind: 'mandate' },
        },
      }),
    )
    expect(
      capturedChildOwnSources(
        accepted,
        proposed,
        [history([child, abandon, competitor, otherAbandon], childScope)],
        [],
      ),
    ).toBeNull()
  })

  it('accepts the actual full identity set and rejects an omitted constraint', () => {
    const { mandate, fixture, parsed, histories } = assessment()
    expect(checkAuthenticatedSpecCompatibility(fixture.result, parsed, histories, mandate)).toBeNull()
    const first = parsed.compatibility.examined[0]
    const missing: SpecAssessment = {
      ...parsed,
      compatibility: { state: 'consistent', examined: [first], references: [], reason: 'Claimed complete' },
    }
    expect(checkAuthenticatedSpecCompatibility(fixture.result, missing, histories, mandate)).toMatch(/exactly cover/)
  })
  it('rejects an examined criterion attributed to the wrong accepted version', () => {
    const { mandate, fixture, parsed, histories } = assessment()
    type Constraint = SpecAssessment['compatibility']['examined'][number]
    const wrongVersion = (constraint: Constraint): Constraint =>
      constraint.kind === 'accepted'
        ? {
            ...constraint,
            target: { ...constraint.target, spec: { ...constraint.target.spec, version: '0'.repeat(64) } },
          }
        : constraint
    const [first, ...rest] = parsed.compatibility.examined
    const wrongAssessment: SpecAssessment = {
      ...parsed,
      compatibility: {
        state: 'consistent',
        examined: [wrongVersion(first), ...rest.map(wrongVersion)],
        references: [],
        reason: 'Wrong version',
      },
    }
    expect(checkAuthenticatedSpecCompatibility(fixture.result, wrongAssessment, histories, mandate)).toMatch(
      /exactly cover/,
    )
  })

  it('rejects repeated constraints and uncaptured file citations', () => {
    const { mandate, fixture, parsed, histories } = assessment()
    const first = parsed.compatibility.examined[0]
    const repeated: SpecAssessment = {
      ...parsed,
      compatibility: { state: 'consistent', examined: [first, first], references: [], reason: 'Repeated' },
    }
    expect(checkAuthenticatedSpecCompatibility(fixture.result, repeated, histories, mandate)).toMatch(/exactly cover/)
    if (parsed.compatibility.state !== 'consistent') throw new Error('fixture must be consistent')
    const cited = {
      ...parsed,
      compatibility: {
        ...parsed.compatibility,
        references: [
          {
            source: 'git-file' as const,
            repository: 'other/app',
            commit: 'a'.repeat(40),
            path: 'evidence.txt',
            digest: 'b'.repeat(64),
          },
        ],
      },
    }
    expect(checkAuthenticatedSpecCompatibility(fixture.result, cited, histories, mandate)).toMatch(/not authenticated/)
  })
})
