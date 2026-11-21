import { expect, test } from 'vitest'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveSpecEffective, type SpecEffectiveRequest } from '../spec-effective.ts'
import { resolveAcceptedSpec, resolveAcceptedSpecAt, resolveAcceptedSpecPrefixes } from '../workflow-accepted-spec.ts'
import { observeAssessmentContextReplay, workflowContextTerminal } from '../workflow-context-terminal.ts'
import { recordsOf } from '../workflow-control.ts'
import { resolveOwnSpecAuthority } from '../workflow-mandate-admission.ts'
import { appendRecords, interruptionResolution, receiptOf } from './workflow-interruption-support.ts'
import { assessFixture, mandateAssessmentState, shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { BODY, history, must, pauseControls, SCOPE } from './workflow-test-support.ts'

test('observes only a linked authenticated pending expanded-context assessment', async () => {
  const mandated = shippedFeatureMandate()
  const initial = mandateAssessmentState(mandated)
  const proposed = {
    snapshot: initial.snapshot,
    tier: initial.tier,
    children: initial.children,
    inheritedOwnSpecRefs: initial.inheritedOwnSpecRefs,
    coverage: initial.coverage,
  }
  const prior = assessFixture(mandated, 'negative-replay', initial, proposed, 'editorial', [history([mandated])])
  if (
    prior.start.kind !== 'action-receipt' ||
    prior.start.payload.action !== 'assess-spec' ||
    prior.start.payload.phase !== 'start'
  )
    throw new Error('expected assessment start')
  const negative = must(
    buildRecord({
      ...prior.result,
      payload: {
        ...prior.result.payload,
        structured: {
          outcome: 'missing-context',
          missing: [{ locator: { kind: 'information-request', description: 'policy' }, reason: 'needed', targets: [] }],
        },
      },
    }),
  )
  if (
    negative.kind !== 'action-receipt' ||
    negative.payload.action !== 'assess-spec' ||
    negative.payload.phase !== 'result'
  )
    throw new Error('expected assessment result')
  const lineage = {
    source: 'record' as const,
    record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: negative.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(negative.payload),
  }
  const added = {
    source: 'git-file' as const,
    repository: SCOPE.repository,
    commit: 'b'.repeat(40),
    path: 'policy.txt',
    digest: 'c'.repeat(64),
  }
  const manifest = { ...prior.start.payload.inputs.manifest, expandedContext: [lineage, added] }
  const inputs = { ...prior.start.payload.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const start = must(
    buildRecord({
      ...prior.start,
      recordId: 'expanded-start',
      operationId: 'expanded-op',
      payload: { ...prior.start.payload, actionId: 'expanded-action', inputs },
    }),
  )
  if (start.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
    throw new Error('expected expanded assessment start')
  const replay = { uw: SCOPE, actionId: 'expanded-action', fingerprint: inputs.fingerprint }
  const issue = history([mandated, prior.start, negative, start])
  const readBack = recordsOf(issue).find((record) => record.recordId === start.recordId)
  if (
    readBack?.kind !== 'action-receipt' ||
    readBack.payload.action !== 'assess-spec' ||
    readBack.payload.phase !== 'start'
  )
    throw new Error('Assessment START was not read back')
  expect(workflowContextTerminal(issue, 'assess-spec')).toBe('uncertain')
  expect(observeAssessmentContextReplay(issue, readBack)).toBe('observed')
  expect(observeAssessmentContextReplay(issue, { ...readBack })).toBe('uncertain')
  expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [issue], replay)).toMatchObject({ ok: true })
  expect(resolveAcceptedSpecAt(mandated, [issue], initial.ref, replay)).toMatchObject({ ok: true })
  expect(resolveAcceptedSpecPrefixes(mandated, [issue], replay)).toMatchObject({ ok: true })
  const pause = pauseControls(mandated, 'expanded-interruption-pause')
  const resolution = interruptionResolution({
    mandate: mandated,
    pause: pause.confirmed,
    start: receiptOf(start),
    result: null,
  })
  const successor = must(
    buildRecord({
      ...start,
      recordId: 'replacement-expanded-start',
      operationId: 'replacement-expanded-op',
      payload: { ...start.payload, actionId: 'replacement-expanded-action' },
    }),
  )
  const pending = appendRecords(history([mandated, prior.start, negative, start, pause.requested, pause.confirmed]), [
    resolution,
    pause.resumed,
    successor,
  ])
  const pendingReplay = { ...replay, actionId: 'replacement-expanded-action' }
  const original = resolveAcceptedSpec(mandated, [history([mandated])])
  expect(original.ok).toBe(true)
  expect(resolveAcceptedSpec(mandated, [pending], pendingReplay)).toEqual(original)
  const positive = must(
    buildRecord({
      ...prior.result,
      recordId: 'replacement-expanded-result',
      operationId: 'replacement-expanded-result-op',
      payload: {
        ...prior.result.payload,
        actionId: 'replacement-expanded-action',
        inputs,
        start: { scope: SCOPE, kind: 'action-receipt', recordId: successor.recordId },
      },
    }),
  )
  const completed = appendRecords(pending, [positive])
  expect(resolveAcceptedSpec(mandated, [completed])).toMatchObject({ ok: true })
  const historical: Extract<SpecEffectiveRequest, { mode: 'historical' }> = {
    mode: 'historical',
    own: initial.ref,
    versionVector: [initial.ref, ...initial.inheritedOwnSpecRefs],
    histories: [issue],
  }
  expect(resolveSpecEffective(historical).ok).toBe(false)
  expect(resolveSpecEffective({ ...historical, assessmentReplay: replay }).ok).toBe(true)
  expect(resolveSpecEffective({ ...historical, assessmentReplay: { ...replay, fingerprint: '0'.repeat(64) } }).ok).toBe(
    false,
  )
  expect(
    resolveSpecEffective({ ...historical, assessmentReplay: { ...replay, uw: { ...SCOPE, target: 'issue:999999' } } })
      .ok,
  ).toBe(false)
  const causal = await observeFixtureNativeWorld({
    root: SCOPE,
    nodes: [
      {
        scope: SCOPE,
        title: 'Bounded workflow',
        body: BODY,
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
  expect(resolveOwnSpecAuthority(issue, [], causal, new Set(), replay)).toMatchObject({ ok: true })
  expect(resolveAcceptedSpec(mandated, [issue], { ...replay, fingerprint: '0'.repeat(64) })).toMatchObject({
    ok: false,
  })
  expect(resolveAcceptedSpec(mandated, [history([mandated, negative])])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [history([mandated, negative, start])], replay)).toMatchObject({ ok: false })
  const mismatched = must(
    buildRecord({
      ...negative,
      payload: { ...negative.payload, start: { ...negative.payload.start, recordId: 'unrelated-start' } },
    }),
  )
  expect(resolveAcceptedSpec(mandated, [history([mandated, prior.start, mismatched])])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [history([mandated, prior.start, mismatched, start])], replay)).toMatchObject({
    ok: false,
  })
  const competing = must(buildRecord({ ...negative, recordId: 'competing-result', operationId: 'competing-op' }))
  expect(resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, competing])])).toMatchObject({
    ok: false,
  })
  expect(
    resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, competing, start])], replay),
  ).toMatchObject({ ok: false })
  const wrongManifest = { ...manifest, expandedContext: [added] }
  const wrongInputs = { ...inputs, manifest: wrongManifest, fingerprint: actionInputDigest(wrongManifest) }
  const wrongStart = must(buildRecord({ ...start, payload: { ...start.payload, inputs: wrongInputs } }))
  expect(
    resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, wrongStart])], {
      ...replay,
      fingerprint: wrongInputs.fingerprint,
    }),
  ).toMatchObject({ ok: false })
  const other = assessFixture(mandated, 'other-expanded-pending', initial, proposed, 'editorial', [history([mandated])])
  expect(
    resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, start, other.start])], replay),
  ).toMatchObject({ ok: false })
})
