import { describe, expect, test } from 'vitest'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { selectApplicableMandate } from '../workflow-mandate-admission.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import { assessFixture } from './workflow-spec-assessment-support.ts'
import { BODY, facts, featureMandate, history, must, SCOPE } from './workflow-test-support.ts'

describe('workflow Spec assessment behavior', () => {
  test('requires a fresh authenticated assessment when the live spec changes after a completed material pair', () => {
    const { featureMandate: shippedFeatureMandate } = roxabiWorkflowFixtures()
    const mandated = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: BODY,
    })
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const bodyB = 'material body B'
    const bodyC = 'material body C'
    const historical = assessFixture(mandated, 'material-a-b', BODY, bodyB, 'material')
    const live = assessFixture(mandated, 'material-a-c', BODY, bodyC, 'material')
    const decisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent' as const, evidence: [] },
      landing: { status: 'absent' as const, evidence: [] },
      watch: { status: 'absent' as const, evidence: [] },
    }
    const staleEvidence = {
      issue: history([mandated, historical.start, historical.result]),
      pullRequest: null,
      parents: [],
    }
    const liveFacts = facts({
      productVersion: mandated.payload.config.productVersion,
      configVersion: mandated.payload.config.version,
      configDigest: mandated.payload.config.digest,
      supportedConfigVersions: [mandated.payload.config.version],
      specBody: bodyC,
      specDigest: specDigest(bodyC),
    })
    expect(reconstructWorkflow({ evidence: staleEvidence, facts: liveFacts, decisions })).toMatchObject({
      status: 'action',
      action: 'assess-spec',
      mandateId: mandated.recordId,
    })
    expect(
      reconstructWorkflow({
        evidence: { ...staleEvidence, issue: history([mandated, historical.start, historical.result, live.start]) },
        facts: liveFacts,
        decisions,
      }),
    ).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
  test('does not treat a returned editorial Spec as a competing current-pair assessment', () => {
    const mandated = featureMandate()
    const bodyB = 'editorial body B'
    const bodyC = 'editorial body C'
    const first = assessFixture(mandated, 'editorial-a-b', BODY, bodyB, 'editorial')
    const second = assessFixture(mandated, 'editorial-b-c', bodyB, bodyC, 'editorial')
    const returned = assessFixture(mandated, 'editorial-c-b', bodyC, bodyB, 'editorial')
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
      spec: { body: bodyB, digest: specDigest(bodyB) },
    })
    expect(
      reconstructWorkflow({
        evidence,
        facts: facts({ specBody: bodyB, specDigest: specDigest(bodyB) }),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
        },
      }),
    ).toMatchObject({ status: 'action', mandateId: mandated.recordId })
  })
  test('does not let a predecessor material assessment govern its selected successor', () => {
    const predecessor = featureMandate()
    if (predecessor.kind !== 'mandate') throw new Error('expected a mandate')
    const successorBody = 'successor accepts the current Spec'
    const stale = assessFixture(predecessor, 'predecessor-material', BODY, successorBody, 'material')
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
    const successor = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'mandate-successor',
        runId: 'run-1',
        operationId: 'op-mandate-successor',
        kind: 'mandate',
        payload: {
          ...predecessor.payload,
          antecedent: { scope: SCOPE, recordId: predecessor.recordId, kind: 'mandate' },
          spec: {
            ...predecessor.payload.spec,
            body: successorBody,
            bodySha256: specDigest(successorBody),
          },
        },
      }),
    )
    if (successor.kind !== 'mandate') throw new Error('expected a successor mandate')
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
    expect(
      reconstructWorkflow({
        evidence,
        facts: facts({ specBody: successorBody, specDigest: specDigest(successorBody) }),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
        },
      }),
    ).toMatchObject({ status: 'action', mandateId: successor.recordId })

    const first = assessFixture(successor, 'successor-material-a', successorBody, 'next Spec', 'material')
    const second = assessFixture(successor, 'successor-material-b', successorBody, 'next Spec', 'material')
    expect(
      reconstructWorkflow({
        evidence: {
          issue: history([successor, first.start, first.result, second.start, second.result]),
          pullRequest: null,
          parents: [],
        },
        facts: facts({ specBody: 'next Spec', specDigest: specDigest('next Spec') }),
        decisions: {
          reviewStep: null,
          epicStep: null,
          epicLand: null,
          ciWatchStatus: null,
          publish: { status: 'absent', evidence: [] },
          landing: { status: 'absent', evidence: [] },
          watch: { status: 'absent', evidence: [] },
        },
      }),
    ).toMatchObject({ status: 'terminal', reason: 'spec-ambiguous' })
  })
  test('does not let a sibling, competing, or unreadable assessment approve a spec', () => {
    const mandated = featureMandate()
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const editorial = assessFixture(mandated, 'edit', BODY, 'editorial body', 'editorial')
    const sibling = assessFixture(mandated, 'sibling', BODY, 'sibling body', 'editorial', undefined, 'other-mandate')
    const kept = resolveAcceptedSpec(mandated, [
      history([mandated, sibling.start, sibling.result, editorial.start, editorial.result]),
    ])
    expect(kept).toMatchObject({ ok: true, spec: { body: 'editorial body', digest: editorial.currentDigest } })
    const reversed = assessFixture(mandated, 'rev', BODY, 'other body', 'editorial')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, reversed.start, reversed.result, editorial.start, editorial.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, editorial.start, editorial.result, reversed.start, reversed.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const unknown = assessFixture(mandated, 'unknown', BODY, 'unknown body', 'unknown')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, editorial.start, editorial.result, unknown.start, unknown.result]),
      ]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const malformed = assessFixture(mandated, 'malformed', BODY, 'malformed body', null)
    expect(resolveAcceptedSpec(mandated, [history([mandated, malformed.start, malformed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    expect(resolveAcceptedSpec(mandated, [history([mandated, editorial.start])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const second = must(parseRecord({ ...editorial.result, recordId: 'edit-again', operationId: 'op-edit-again' }))
    expect(
      resolveAcceptedSpec(mandated, [history([mandated, editorial.start, second, editorial.result])]),
    ).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    })
    const failed = assessFixture(mandated, 'failed', BODY, 'failed body', 'editorial', {
      completion: 'error',
      strict: 'valid',
    })
    expect(resolveAcceptedSpec(mandated, [history([mandated, failed.start, failed.result])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const startBody = 'start-only body'
    const resultBody = 'result-only body'
    const driftedStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'drift-start',
        runId: 'run-1',
        operationId: 'op-drift-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'assess-spec',
          actionId: 'act-drift',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          exactInputs: {
            acceptedDigest: specDigest(BODY),
            currentDigest: specDigest(startBody),
            acceptedBody: BODY,
            currentBody: startBody,
          },
        },
      }),
    )
    const driftedResult = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'drift',
        runId: 'run-1',
        operationId: 'op-drift',
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'assess-spec',
          actionId: 'act-drift',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: SCOPE, recordId: 'drift-start', kind: 'action-receipt' },
          exactInputs: {
            acceptedDigest: specDigest(BODY),
            currentDigest: specDigest(resultBody),
            acceptedBody: BODY,
            currentBody: resultBody,
          },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { classification: 'editorial' },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, driftedStart, driftedResult])])).toMatchObject({
      ok: false,
      reason: 'incomplete',
    })
    const matched = assessFixture(mandated, 'material', BODY, 'material body', 'material')
    const accepted = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'accept-material',
        runId: 'run-1',
        operationId: 'op-accept-material',
        kind: 'operator-control',
        payload: {
          control: 'accept-material',
          controlId: 'accept-material',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          assessment: { scope: SCOPE, recordId: matched.result.recordId, kind: 'action-receipt' },
          specDigest: matched.currentDigest,
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, matched.start, matched.result, accepted])])).toMatchObject(
      {
        ok: true,
        spec: { body: 'material body', digest: matched.currentDigest },
      },
    )
    const stale = assessFixture(mandated, 'stale', 'stale body', 'next body', 'material')
    const staleControl = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'accept-stale',
        runId: 'run-1',
        operationId: 'op-accept-stale',
        kind: 'operator-control',
        payload: {
          control: 'accept-material',
          controlId: 'accept-stale',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          predecessor: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          assessment: { scope: SCOPE, recordId: stale.result.recordId, kind: 'action-receipt' },
          specDigest: stale.currentDigest,
        },
      }),
    )
    expect(resolveAcceptedSpec(mandated, [history([mandated, stale.start, stale.result, staleControl])])).toMatchObject(
      {
        ok: false,
        reason: 'material-spec',
      },
    )
    const materialClaim = assessFixture(mandated, 'claim', BODY, 'claimed body', 'material')
    expect(
      resolveAcceptedSpec(mandated, [
        history([mandated, materialClaim.start, materialClaim.result, editorial.start, editorial.result]),
      ]),
    ).toMatchObject({ ok: false, reason: 'ambiguous' })
  })
})
