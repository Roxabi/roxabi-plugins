import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { prepareMaterialAcceptance } from '../workflow-material-acceptance.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  acceptedAssessmentState,
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  type ProposedAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { facts, history, must, SCOPE } from './workflow-test-support.ts'

const workflowFixtures = roxabiWorkflowFixtures()

function shippedFeatureMandate(): MandateRecord {
  return workflowFixtures.featureMandate(SCOPE, {
    recordId: 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: 'ship the bounded workflow',
  })
}

function decisions() {
  return {
    reviewStep: null,
    epicStep: null,
    epicLand: null,
    ciWatchStatus: null,
    publish: { status: 'absent' as const, evidence: [] },
    landing: { status: 'absent' as const, evidence: [] },
    watch: { status: 'absent' as const, evidence: [] },
  }
}

function currentFacts(mandated: MandateRecord, currentSpec: ProposedAssessmentState) {
  return facts({
    productVersion: mandated.payload.config.productVersion,
    configVersion: mandated.payload.config.version,
    configDigest: mandated.payload.config.digest,
    supportedConfigVersions: [mandated.payload.config.version],
    currentSpec,
    identityAllocations: mandated.payload.ownSpec.identityAllocations,
  })
}

describe('workflow Spec assessment behavior', () => {
  test('requires a fresh authenticated assessment when the live Spec changes after an accepted material decision', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const historical = assessFixture(
      mandated,
      'material-a-b',
      initial,
      proposedAssessmentState(initial, { body: 'material body B' }),
      'material',
    )
    const accepted = acceptMaterialFixture(mandated, 'accept-material-a-b', historical)
    const afterHistorical = acceptedMaterialState(historical, accepted)
    const live = assessFixture(
      mandated,
      'material-b-c',
      afterHistorical,
      proposedAssessmentState(afterHistorical, { body: 'material body C' }),
      'material',
    )
    const staleRecords = [mandated, historical.start, historical.result, accepted]
    const staleEvidence = {
      issue: history(staleRecords),
      pullRequest: null,
      parents: [],
    }
    const liveFacts = currentFacts(mandated, live.proposed)
    expect(reconstructWorkflow({ evidence: staleEvidence, facts: liveFacts, decisions: decisions() })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
      mandateId: mandated.recordId,
    })
    expect(
      reconstructWorkflow({
        evidence: { ...staleEvidence, issue: history([...staleRecords, live.start]) },
        facts: liveFacts,
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })

  test('does not dispatch assessment when a pinned graph reaches it without current Spec facts', () => {
    const baseline = shippedFeatureMandate()
    const graph = {
      version: 1,
      productVersion: baseline.payload.config.productVersion,
      configVersion: baseline.payload.config.version,
      edgeOrder: 'array' as const,
      nodes: [{ id: 'assess-spec', action: 'assess-spec' as const }],
      edges: [],
      initial: 'assess-spec',
    }
    const mandated = workflowFixtures.featureMandate(SCOPE, {
      body: 'ship the bounded workflow',
      config: {
        version: baseline.payload.config.version,
        digest: baseline.payload.config.digest,
        effective: { graph },
      },
    })
    const decision = reconstructWorkflow({
      evidence: { issue: history([mandated]), pullRequest: null, parents: [] },
      facts: facts({
        productVersion: mandated.payload.config.productVersion,
        configVersion: mandated.payload.config.version,
        configDigest: mandated.payload.config.digest,
        supportedConfigVersions: [mandated.payload.config.version],
      }),
      decisions: decisions(),
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'unknown-outcome' })
    expect(decision).not.toMatchObject({ status: 'action', action: 'assess-spec' })
  })

  test('keeps a pending authenticated material assessment through date-only current metadata drift', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const pending = assessFixture(
      mandated,
      'date-only-material',
      initial,
      proposedAssessmentState(initial, { body: 'material body with unchanged canonical content' }),
      'material',
    )
    const dateOnlyCurrent = {
      ...pending.proposed,
      snapshot: {
        ...pending.proposed.snapshot,
        raw: { ...pending.proposed.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
      },
    }
    const issueHistory = history([mandated, pending.start, pending.result])
    const histories = [issueHistory]
    expect(
      reconstructWorkflow({
        evidence: { issue: issueHistory, pullRequest: null, parents: [] },
        facts: currentFacts(mandated, dateOnlyCurrent),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
    expect(
      prepareMaterialAcceptance({
        uw: SCOPE,
        operationId: 'op-date-only-accept',
        histories,
        mandate: mandated,
        currentProposed: dateOnlyCurrent,
        identityAllocations: mandated.payload.ownSpec.identityAllocations,
      }),
    ).toMatchObject({ ok: true })
  })

  test('requires a material decision for an editorial assessment of a tier change', () => {
    const mandated = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = { snapshot: accepted.snapshot, tier: 'F-lite' as const, children: accepted.children }
    const assessment = assessFixture(mandated, 'editorial-tier-change', accepted, proposed, 'editorial')
    const issue = history([mandated, assessment.start, assessment.result])

    expect(accepted.tier).toBe('S')
    expect(assessment.result.payload.exactInputs.mechanical).toMatchObject({
      added: [],
      removed: [],
      exclusionsChanged: false,
      tierChanged: true,
      childrenChanged: false,
    })
    expect(assessment.proposed.snapshot.spec).toEqual(accepted.snapshot.spec)
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: true, spec: accepted })
    expect(
      reconstructWorkflow({
        evidence: { issue, pullRequest: null, parents: [] },
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
  })

  test('refuses an authenticated editorial tier assessment with a false mechanical delta', () => {
    const mandated = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = { snapshot: accepted.snapshot, tier: 'F-lite' as const, children: accepted.children }
    const assessment = assessFixture(mandated, 'false-editorial-tier-delta', accepted, proposed, 'editorial')
    if (assessment.start.kind !== 'action-receipt') throw new Error('expected assessment start fixture')
    const startPayload = assessment.start.payload
    if (startPayload.phase !== 'start' || startPayload.action !== 'assess-spec')
      throw new Error('expected assessment start fixture')
    const exactInputs = {
      ...assessment.result.payload.exactInputs,
      mechanical: { ...assessment.result.payload.exactInputs.mechanical, tierChanged: false },
    }
    const start = must(buildRecord({ ...assessment.start, payload: { ...startPayload, exactInputs } }))
    const result = must(buildRecord({ ...assessment.result, payload: { ...assessment.result.payload, exactInputs } }))
    const issue = history([mandated, start, result])

    expect(accepted.tier).toBe('S')
    expect(proposed.tier).toBe('F-lite')
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: false,
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
    expect(
      reconstructWorkflow({
        evidence: { issue, pullRequest: null, parents: [] },
        facts: currentFacts(mandated, proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
  })

  test('accepts a genuinely non-mechanical editorial assessment without a material decision', () => {
    const mandated = shippedFeatureMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = proposedAssessmentState(accepted, { body: 'editorially revised wording' })
    const assessment = assessFixture(mandated, 'editorial-wording-only', accepted, proposed, 'editorial')
    const issue = history([mandated, assessment.start, assessment.result])

    expect(assessment.result.payload.exactInputs.mechanical).toMatchObject({
      added: [],
      removed: [],
      exclusionsChanged: false,
      tierChanged: false,
      childrenChanged: false,
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: { ref: { version: assessment.currentVersion, sourceAccepted: { recordId: assessment.result.recordId } } },
    })
    expect(
      reconstructWorkflow({
        evidence: { issue, pullRequest: null, parents: [] },
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })

  test('keeps an editorial return as the current accepted source rather than a competing assessment', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const first = assessFixture(
      mandated,
      'editorial-a-b',
      initial,
      proposedAssessmentState(initial, { body: 'editorial body B' }),
      'editorial',
    )
    const afterFirst = acceptedAssessmentState(first)
    const second = assessFixture(
      mandated,
      'editorial-b-c',
      afterFirst,
      proposedAssessmentState(afterFirst, { body: 'editorial body C' }),
      'editorial',
    )
    const afterSecond = acceptedAssessmentState(second)
    const returned = assessFixture(
      mandated,
      'editorial-c-b',
      afterSecond,
      proposedAssessmentState(afterSecond, { body: 'editorial body B' }),
      'editorial',
    )
    const evidence = {
      issue: history([
        mandated,
        first.start,
        first.result,
        second.start,
        second.result,
        returned.start,
        returned.result,
      ]),
      pullRequest: null,
      parents: [],
    }
    expect(resolveAcceptedSpec(mandated, [evidence.issue])).toMatchObject({
      ok: true,
      spec: { ref: { version: returned.currentVersion }, snapshot: { spec: { version: returned.currentVersion } } },
    })
    expect(
      reconstructWorkflow({
        evidence,
        facts: currentFacts(mandated, returned.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })

  test('does not let a predecessor material assessment govern its selected successor', () => {
    const predecessor = shippedFeatureMandate()
    const predecessorState = mandateAssessmentState(predecessor)
    const stale = assessFixture(
      predecessor,
      'predecessor-material',
      predecessorState,
      proposedAssessmentState(predecessorState, { body: 'successor accepts the current Spec' }),
      'material',
    )
    const abandoned = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'abandon-predecessor',
        runId: 'run-1',
        operationId: 'op-abandon-predecessor',
        kind: 'operator-control',
        payload: {
          control: 'abandon',
          controlId: 'abandon-predecessor',
          mandate: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          predecessor: null,
        },
      }),
    )
    const successor = workflowFixtures.featureMandate(SCOPE, {
      recordId: 'mandate-successor',
      runId: 'run-1',
      operationId: 'op-mandate-successor',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: 'successor accepts the current Spec',
      antecedent: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
    })
    const selected = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'select-successor',
        runId: 'run-1',
        operationId: 'op-select-successor',
        kind: 'operator-control',
        payload: {
          control: 'select-successor',
          controlId: 'select-successor',
          mandate: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          successor: { scope: SCOPE, recordId: successor.recordId, kind: 'mandate' },
        },
      }),
    )
    const evidence = {
      issue: history([predecessor, stale.start, stale.result, abandoned, successor, selected]),
      pullRequest: null,
      parents: [],
    }
    expect(selectApplicableMandate(evidence.issue)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    const successorState = mandateAssessmentState(successor)
    const successorCurrent = {
      snapshot: successor.payload.ownSpec.snapshot,
      tier: successor.payload.tier,
      children: successor.payload.children,
    }
    expect(
      reconstructWorkflow({
        evidence,
        facts: currentFacts(successor, successorCurrent),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: successor.recordId })

    const first = assessFixture(
      successor,
      'successor-material-a',
      successorState,
      proposedAssessmentState(successorState, { body: 'next Spec' }),
      'material',
    )
    const second = assessFixture(
      successor,
      'successor-material-b',
      successorState,
      proposedAssessmentState(successorState, { body: 'next Spec' }),
      'material',
    )
    expect(
      reconstructWorkflow({
        evidence: {
          issue: history([successor, first.start, first.result, second.start, second.result]),
          pullRequest: null,
          parents: [],
        },
        facts: currentFacts(successor, first.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'terminal', reason: 'spec-ambiguous' })
  })

  test('rejects competing, malformed, and unauthenticated assessments without dropping valid editorial continuity', () => {
    const mandated = shippedFeatureMandate()
    const initial = mandateAssessmentState(mandated)
    const editorial = assessFixture(
      mandated,
      'edit',
      initial,
      proposedAssessmentState(initial, { body: 'editorial body' }),
      'editorial',
    )
    const sibling = assessFixture(
      mandated,
      'sibling',
      initial,
      proposedAssessmentState(initial, { body: 'sibling body' }),
      'editorial',
      undefined,
      'other-mandate',
    )
    const kept = resolveAcceptedSpec(mandated, [
      history([mandated, sibling.start, sibling.result, editorial.start, editorial.result]),
    ])
    expect(kept).toMatchObject({ ok: true, spec: { ref: { version: editorial.currentVersion } } })

    const reversed = assessFixture(
      mandated,
      'rev',
      initial,
      proposedAssessmentState(initial, { body: 'other body' }),
      'editorial',
    )
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, reversed.start, reversed.result, editorial.start, editorial.result]),
      ]),
    ).toMatchObject({ ok: false, reason: 'ambiguous' })

    const malformed = assessFixture(
      mandated,
      'malformed',
      initial,
      proposedAssessmentState(initial, { body: 'malformed body' }),
      null,
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, malformed.start, malformed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    expect(resolveAcceptedSpec(mandated, [history([mandated, editorial.start])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })

    const duplicate = must(parseRecord({ ...editorial.result, recordId: 'edit-again', operationId: 'op-edit-again' }))
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, editorial.start, duplicate, editorial.result])]),
    ).toMatchObject({ ok: false, reason: 'ambiguous' })

    const failed = assessFixture(
      mandated,
      'failed',
      initial,
      proposedAssessmentState(initial, { body: 'failed body' }),
      'editorial',
      { completion: 'error', strict: 'valid' },
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, failed.start, failed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })

    const driftStart = assessFixture(
      mandated,
      'drift-start-source',
      initial,
      proposedAssessmentState(initial, { body: 'start-only body' }),
      'editorial',
    )
    const driftResult = assessFixture(
      mandated,
      'drift-result-source',
      initial,
      proposedAssessmentState(initial, { body: 'result-only body' }),
      'editorial',
    )
    if (driftStart.start.kind !== 'action-receipt') throw new Error('expected assessment start fixture')
    const driftStartPayload = driftStart.start.payload
    if (driftStartPayload.phase !== 'start' || driftStartPayload.action !== 'assess-spec')
      throw new Error('expected assessment start fixture')
    const driftedStart = must(
      parseRecord({
        ...driftStart.start,
        recordId: 'drift-start',
        operationId: 'op-drift-start',
        payload: { ...driftStartPayload, actionId: 'act-drift' },
      }),
    )
    const driftedResult = must(
      parseRecord({
        ...driftResult.result,
        recordId: 'drift',
        operationId: 'op-drift',
        inputs: driftResult.result.inputs.map((input) =>
          input === driftResult.start.recordId ? driftedStart.recordId : input,
        ),
        payload: {
          ...driftResult.result.payload,
          actionId: 'act-drift',
          start: { scope: SCOPE, recordId: driftedStart.recordId, kind: 'action-receipt' },
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, driftedStart, driftedResult])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
  })
})
