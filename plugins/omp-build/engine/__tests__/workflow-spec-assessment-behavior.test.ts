import { describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { resolveSpecIdentityLedger } from '../uw-identity.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveOwnSpecAuthority, selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  type AssessmentState,
  acceptedAssessmentState,
  assessFixture,
  currentFacts,
  decisions,
  mandateAssessmentState,
  proposedAssessmentState,
  shippedFeatureMandate,
} from './workflow-spec-assessment-support.ts'
import { facts, history, must, SCOPE } from './workflow-test-support.ts'

const workflowFixtures = roxabiWorkflowFixtures()

const nativeInitialBody = strictSpecBody('ship the bounded workflow')
function parsedNativeSpec(body: string) {
  const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
function nativeMandate() {
  const mandate = shippedFeatureMandate()
  const record = must(
    parseRecord({
      ...mandate,
      payload: {
        ...mandate.payload,
        ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(nativeInitialBody)),
      },
    }),
  )
  if (record.kind !== 'mandate') throw new Error('Expected a native mandate')
  return record
}
function nativeProposal(accepted: AssessmentState, body: string) {
  const spec = parsedNativeSpec(body).spec
  return proposedAssessmentState(accepted, {
    body,
    content: {
      criteria: spec.criteria,
      invariants: spec.invariants,
      exclusions: spec.exclusions,
      openQuestions: spec.openQuestions,
      sections: spec.sections,
    },
  })
}

async function nativeEvidence(issue: DecodedHistory, body: string, tier: 'S' | 'F-lite') {
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body,
        updatedAt: '2026-10-21T00:00:00Z',
        labels: [`size:${tier}`],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [issue],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  return { issue, pullRequest: null, parents: [], causal }
}

describe('workflow Spec assessment behavior', () => {
  test('accepts equivalent same-scope observations and refuses conflicting native history claims', () => {
    const mandate = nativeMandate()
    const original = history([mandate])
    const independentlyDecoded = decodeHistory(original.source)
    const unique = resolveAcceptedSpec(mandate, [original])
    expect(unique).toMatchObject({ ok: true })
    expect(independentlyDecoded).not.toBe(original)
    expect(resolveAcceptedSpec(mandate, [original, independentlyDecoded])).toEqual(unique)
    expect(resolveAcceptedSpec(mandate, [original, original])).toEqual(unique)

    const variants = [
      decodeHistory({
        ...original.source,
        comments: original.source.comments.map((comment, index) =>
          index === 0 ? { ...comment, createdAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z' } : comment,
        ),
      }),
      decodeHistory({ ...original.source, stopAuthor: 'different-stop-author' }),
      decodeHistory({ ...original.source, complete: false }),
      decodeHistory({ ...original.source, diagnostics: [{ code: 'incomplete', message: 'Page unavailable' }] }),
    ]
    for (const conflicting of variants) {
      const refusal = {
        ok: false,
        reason: 'incomplete',
        evidence: [{ code: 'ambiguous', message: 'Conflicting histories claim the same scope' }],
      }
      expect(resolveAcceptedSpec(mandate, [original, conflicting])).toMatchObject(refusal)
      expect(resolveAcceptedSpec(mandate, [original, independentlyDecoded, conflicting])).toMatchObject(refusal)
    }
  })

  test('allows only an authenticated current assessment replay without weakening other starts', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: initial.snapshot,
      tier: initial.tier,
      children: initial.children,
      inheritedOwnSpecRefs: initial.inheritedOwnSpecRefs,
      coverage: initial.coverage,
    }
    const assessment = assessFixture(mandated, 'replay', initial, proposed, 'editorial', [history([mandated])])
    const start = assessment.start
    if (start.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
      throw new Error('expected assessment start')
    const context = { uw: SCOPE, actionId: start.payload.actionId, fingerprint: start.payload.inputs.fingerprint }
    const issue = history([mandated, start])
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: false, reason: 'incomplete' })
    expect(resolveAcceptedSpec(mandated, [issue], context)).toMatchObject({ ok: true })
    const resolved = resolveAcceptedSpec(mandated, [issue], context)
    if (!resolved.ok) throw new Error('expected authenticated replay')
    const ledger = { uw: SCOPE, history: issue, histories: [issue], accepted: resolved.spec }
    expect(resolveSpecIdentityLedger(ledger)).toMatchObject({ ok: false })
    expect(resolveSpecIdentityLedger({ ...ledger, assessmentReplay: context })).toMatchObject({ ok: true })
    expect(resolveSpecIdentityLedger({ ...ledger, assessmentReplay: { ...context, actionId: 'other' } })).toMatchObject(
      { ok: false },
    )
    const historical = must(parseRecord({ ...mandated, recordId: 'historical-mandate', operationId: 'historical-op' }))
    const foreignStart = {
      ...start,
      recordId: 'foreign-start',
      operationId: 'foreign-op',
      payload: { ...start.payload, mandate: { ...start.payload.mandate, recordId: historical.recordId } },
    }
    const combined = history([mandated, historical, start, foreignStart])
    const foreignParts = new Set(
      combined.operations.find((entry) => entry.recordId === foreignStart.recordId)?.parts.map((part) => part.nativeId),
    )
    const withForeign = decodeHistory({
      ...combined.source,
      comments: combined.source.comments.map((comment) =>
        foreignParts.has(comment.nativeId) ? { ...comment, author: 'stranger' } : comment,
      ),
    })
    expect(
      resolveSpecIdentityLedger({
        uw: SCOPE,
        history: withForeign,
        histories: [withForeign],
        accepted: resolved.spec,
        assessmentReplay: context,
      }),
    ).toMatchObject({ ok: true })
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeInitialBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    expect(resolveOwnSpecAuthority(issue, [], causal)).toMatchObject({ ok: false })
    expect(resolveOwnSpecAuthority(issue, [], causal, new Set(), context)).toMatchObject({ ok: true })
    expect(resolveAcceptedSpec(mandated, [issue], { ...context, actionId: 'other' })).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [issue], { ...context, fingerprint: '0'.repeat(64) })).toMatchObject({
      ok: false,
    })

    const duplicate = must(parseRecord({ ...start, recordId: 'duplicate-start', operationId: 'duplicate-start-op' }))
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, duplicate])], context)).toMatchObject({ ok: false })
    const other = assessFixture(mandated, 'another-pending', initial, proposed, 'editorial', [history([mandated])])
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, other.start])], context)).toMatchObject({
      ok: false,
    })
    const conflicting = must(
      buildRecord({
        ...assessment.result,
        payload: {
          ...assessment.result.payload,
          start: { ...assessment.result.payload.start, recordId: 'other-start' },
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, start, conflicting])], context)).toMatchObject({
      ok: false,
    })

    const operation = issue.operations.find((entry) => entry.recordId === start.recordId)
    if (operation === undefined) throw new Error('missing start operation')
    const altered = (changes: Partial<typeof operation>) => ({
      ...issue,
      operations: issue.operations.map((entry) => (entry === operation ? { ...entry, ...changes } : entry)),
    })
    expect(resolveAcceptedSpec(mandated, [altered({ authority: 'authority' })], context)).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [altered({ authority: 'foreign' })], context)).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, author: 'other' })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    expect(resolveAcceptedSpec(mandated, [altered({ parts: [] })], context)).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, nativeId: null })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    expect(
      resolveAcceptedSpec(
        mandated,
        [
          altered({
            parts: operation.parts.map((part) => ({ ...part, updatedAt: '2025-01-01T00:00:01Z' })),
          }),
        ],
        context,
      ),
    ).toMatchObject({ ok: false })
    const invalidInputs = { ...start.payload.inputs, fingerprint: '0'.repeat(64) }
    const invalidStart = { ...start, payload: { ...start.payload, inputs: invalidInputs } }
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, invalidStart])], {
        ...context,
        fingerprint: invalidInputs.fingerprint,
      }),
    ).toMatchObject({ ok: false })
  })

  test('does not dispatch assessment when a pinned graph reaches it without current Spec facts', async () => {
    const baseline = nativeMandate()
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
      body: nativeInitialBody,
      ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(nativeInitialBody)),
      config: {
        version: baseline.payload.config.version,
        digest: baseline.payload.config.digest,
        effective: { graph },
      },
    })
    const decision = reconstructWorkflow({
      evidence: await nativeEvidence(history([mandated]), nativeInitialBody, 'S'),
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

  test('requires a material decision for an editorial assessment of a tier change', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: accepted.snapshot,
      tier: 'F-lite' as const,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }
    const assessment = assessFixture(mandated, 'editorial-tier-change', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
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
        evidence: await nativeEvidence(issue, nativeInitialBody, 'F-lite'),
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'blocked', reason: 'spec-decision-required' })
  })

  test('refuses an authenticated editorial tier assessment with a false mechanical delta', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const proposed = {
      snapshot: accepted.snapshot,
      tier: 'F-lite' as const,
      children: accepted.children,
      inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
      coverage: accepted.coverage,
    }
    const assessment = assessFixture(mandated, 'false-editorial-tier-delta', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
    if (assessment.start.kind !== 'action-receipt') throw new Error('expected assessment start fixture')
    const startPayload = assessment.start.payload
    if (startPayload.phase !== 'start' || startPayload.action !== 'assess-spec')
      throw new Error('expected assessment start fixture')
    const exactInputs = {
      ...assessment.result.payload.exactInputs,
      mechanical: { ...assessment.result.payload.exactInputs.mechanical, tierChanged: false },
    }
    const manifest = {
      ...startPayload.inputs.manifest,
      operands: { action: 'assess-spec' as const, origin: { kind: 'native-current' as const }, exactInputs },
    }
    const inputs = { ...startPayload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    const start = must(buildRecord({ ...assessment.start, payload: { ...startPayload, inputs, exactInputs } }))
    const result = must(
      buildRecord({ ...assessment.result, payload: { ...assessment.result.payload, inputs, exactInputs } }),
    )
    const issue = history([mandated, start, result])

    expect(accepted.tier).toBe('S')
    expect(proposed.tier).toBe('F-lite')
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: false,
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(issue, nativeInitialBody, 'F-lite'),
        facts: currentFacts(mandated, proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({
      status: 'terminal',
      reason: 'spec-ambiguous',
      evidence: [{ message: 'Spec assessment mechanical delta does not match its exact states' }],
    })
  })

  test('accepts a genuinely non-mechanical editorial assessment without a material decision', async () => {
    const mandated = nativeMandate()
    const accepted = mandateAssessmentState(mandated)
    const body = strictSpecBody('editorially revised wording')
    const proposed = nativeProposal(accepted, body)
    const assessment = assessFixture(mandated, 'editorial-wording-only', accepted, proposed, 'editorial', [
      history([mandated]),
    ])
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
        evidence: await nativeEvidence(issue, body, 'S'),
        facts: currentFacts(mandated, assessment.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })

  test('keeps an editorial return as the current accepted source rather than a competing assessment', async () => {
    const mandated = nativeMandate()
    const initial = mandateAssessmentState(mandated)
    const bodyB = strictSpecBody('editorial body B')
    const bodyC = strictSpecBody('editorial body C')
    const first = assessFixture(mandated, 'editorial-a-b', initial, nativeProposal(initial, bodyB), 'editorial', [
      history([mandated]),
    ])
    const afterFirst = acceptedAssessmentState(first)
    const second = assessFixture(
      mandated,
      'editorial-b-c',
      afterFirst,
      nativeProposal(afterFirst, bodyC),
      'editorial',
      [history([mandated, first.start, first.result])],
    )
    const afterSecond = acceptedAssessmentState(second)
    const returned = assessFixture(
      mandated,
      'editorial-c-b',
      afterSecond,
      nativeProposal(afterSecond, bodyB),
      'editorial',
      [history([mandated, first.start, first.result, second.start, second.result])],
    )
    const evidence = await nativeEvidence(
      history([mandated, first.start, first.result, second.start, second.result, returned.start, returned.result]),
      bodyB,
      'S',
    )
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

  test('does not let a predecessor material assessment govern its selected successor', async () => {
    const predecessor = nativeMandate()
    const predecessorState = mandateAssessmentState(predecessor)
    const successorBody = strictSpecBody('successor accepts the current Spec')
    const nextBody = strictSpecBody('next Spec')
    const stale = assessFixture(
      predecessor,
      'predecessor-material',
      predecessorState,
      nativeProposal(predecessorState, successorBody),
      'material',
      [history([predecessor])],
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
      body: successorBody,
      ownSpec: workflowFixtures.ownSpecFromSnapshot(SCOPE, parsedNativeSpec(successorBody)),
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
    const evidence = await nativeEvidence(
      history([predecessor, stale.start, stale.result, abandoned, successor, selected]),
      successorBody,
      'S',
    )
    expect(selectApplicableMandate(evidence.issue, [], evidence.causal)).toMatchObject({
      status: 'applicable',
      mandate: { recordId: successor.recordId },
    })
    const successorState = mandateAssessmentState(successor)
    const successorCurrent = {
      snapshot: successor.payload.ownSpec.snapshot,
      tier: successor.payload.tier,
      children: successor.payload.children,
      inheritedOwnSpecRefs: successor.payload.inheritedOwnSpecRefs,
      coverage: successor.payload.coverage,
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
      nativeProposal(successorState, nextBody),
      'material',
      [evidence.issue],
    )
    const second = assessFixture(
      successor,
      'successor-material-b',
      successorState,
      nativeProposal(successorState, nextBody),
      'material',
      [evidence.issue],
    )
    expect(
      reconstructWorkflow({
        evidence: await nativeEvidence(
          history([
            predecessor,
            stale.start,
            stale.result,
            abandoned,
            successor,
            selected,
            first.start,
            first.result,
            second.start,
            second.result,
          ]),
          nextBody,
          'S',
        ),
        facts: currentFacts(successor, first.proposed),
        decisions: decisions(),
      }),
    ).toMatchObject({ status: 'terminal', reason: 'spec-ambiguous' })
  })
})
