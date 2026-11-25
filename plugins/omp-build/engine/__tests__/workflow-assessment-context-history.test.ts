import { createHash } from 'node:crypto'
import { expect, test } from 'vitest'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { recordGitPinBytes } from '../historical-git-pins.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { workflowContextTerminal } from '../workflow-context-terminal.ts'
import { abandoned, recordsOf } from '../workflow-control.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { appendRecords, interruptionResolution, receiptOf } from './workflow-interruption-support.ts'
import { assessFixture, mandateAssessmentState, shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { history, must, pauseControls, SCOPE } from './workflow-test-support.ts'

test('historical expanded assessment requires a linked completed successor and preserves it after abandonment', () => {
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
  const bytes = Buffer.from('Keep the selected region after reload.\n')
  const added = {
    source: 'git-file' as const,
    repository: SCOPE.repository,
    commit: 'b'.repeat(40),
    path: 'policy.txt',
    digest: createHash('sha256').update(bytes).digest('hex'),
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
  const issue = history([mandated, prior.start, negative, start])
  recordGitPinBytes(issue, [added], bytes)
  const readBack = recordsOf(issue).find((record) => record.recordId === start.recordId)
  if (
    readBack?.kind !== 'action-receipt' ||
    readBack.payload.action !== 'assess-spec' ||
    readBack.payload.phase !== 'start'
  )
    throw new Error('Assessment START was not read back')
  expect(workflowContextTerminal(issue, 'assess-spec', readBack.payload.mandate)).toBe('uncertain')
  const negativeOnly = history([mandated, prior.start, negative])
  expect(workflowContextTerminal(negativeOnly, 'assess-spec', negative.payload.mandate)).toBe('missing')
  expect(
    workflowContextTerminal(negativeOnly, 'assess-spec', { ...negative.payload.mandate, recordId: 'new-mandate' }),
  ).toBe('clear')
  expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: false })
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
  recordGitPinBytes(pending, [added], bytes)
  expect(resolveAcceptedSpec(mandated, [pending])).toMatchObject({ ok: false })
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
  recordGitPinBytes(completed, [added], bytes)
  const beforeAbandonment = resolveAcceptedSpec(mandated, [completed])
  expect(beforeAbandonment).toMatchObject({ ok: true })
  const abandonment = must(
    buildRecord({
      ...SCOPE,
      version: 1,
      recordId: 'abandon-expanded-assessment',
      runId: mandated.runId,
      operationId: 'op-abandon-expanded-assessment',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-expanded-assessment',
        predecessor: null,
        mandate: { scope: SCOPE, kind: 'mandate', recordId: mandated.recordId },
      },
    }),
  )
  const abandonedSource = appendRecords(completed, [abandonment])
  recordGitPinBytes(abandonedSource, [added], bytes)
  expect(abandoned(abandonedSource, mandated)).toBe(true)
  expect(resolveAcceptedSpec(mandated, [abandonedSource])).toEqual(beforeAbandonment)

  const lateResolution = interruptionResolution({
    mandate: mandated,
    pause: pause.confirmed,
    start: receiptOf(successor),
    result: null,
  })
  const liveWithLateResolution = appendRecords(completed, [lateResolution])
  recordGitPinBytes(liveWithLateResolution, [added], bytes)
  expect(resolveAcceptedSpec(mandated, [liveWithLateResolution])).toMatchObject({
    ok: false,
    evidence: [
      {
        code: 'interruption-resolution-invalid',
        recordId: lateResolution.recordId,
        detail: { cause: 'late-result' },
      },
    ],
  })
  const abandonedWithLateResolution = appendRecords(liveWithLateResolution, [abandonment])
  recordGitPinBytes(abandonedWithLateResolution, [added], bytes)
  expect(resolveAcceptedSpec(mandated, [abandonedWithLateResolution])).toEqual(beforeAbandonment)
  expect(resolveAcceptedSpec(mandated, [history([mandated, negative])])).toMatchObject({ ok: false })
  const mismatched = must(
    buildRecord({
      ...negative,
      payload: { ...negative.payload, start: { ...negative.payload.start, recordId: 'unrelated-start' } },
    }),
  )
  expect(resolveAcceptedSpec(mandated, [history([mandated, prior.start, mismatched])])).toMatchObject({ ok: false })
  const competing = must(buildRecord({ ...negative, recordId: 'competing-result', operationId: 'competing-op' }))
  expect(resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, competing])])).toMatchObject({
    ok: false,
  })
})

test.each([true, false])('a plan resolution does not affect Accepted Spec (valid: %s)', (valid) => {
  const mandated = shippedFeatureMandate()
  const pause = pauseControls(mandated, 'plan-interruption-pause')
  const plan = receiptOf(
    must(
      buildRecord({
        ...SCOPE,
        version: 1,
        recordId: 'unrelated-plan-start',
        operationId: 'unrelated-plan-op',
        runId: mandated.runId,
        kind: 'action-receipt',
        payload: {
          format: ACTION_RECEIPT_FORMAT,
          phase: 'start',
          action: 'plan',
          actionId: 'unrelated-plan',
          mandate: { scope: SCOPE, kind: 'mandate', recordId: mandated.recordId },
          exactInputs: {
            mandateId: mandated.recordId,
            specDigest: mandated.payload.ownSpec.version,
            amendsReviewActionId: null,
            requiredBlockers: [],
          },
          inputs: acceptedActionInputs(mandated, 'plan'),
        },
      }),
    ),
  )
  const initial = history([mandated, plan, pause.requested, pause.confirmed])
  const resolution = interruptionResolution({
    mandate: mandated,
    pause: pause.confirmed,
    start: plan,
    result: null,
    ...(valid ? {} : { payload: (payload) => ({ ...payload, proposalDigest: '0'.repeat(64) }) }),
  })
  const spec = resolveAcceptedSpec(mandated, [initial])
  expect(spec.ok).toBe(true)
  expect(resolveAcceptedSpec(mandated, [appendRecords(initial, [resolution])])).toEqual(spec)
})
