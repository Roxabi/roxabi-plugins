import { expect, test } from 'vitest'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import { buildRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { observeAssessmentContextReplay, workflowContextTerminal } from '../workflow-context-terminal.ts'
import { resolveOwnSpecAuthority } from '../workflow-mandate-admission.ts'
import { assessFixture, mandateAssessmentState, shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

test('observes only a linked authenticated pending expanded-context assessment', () => {
  const mandated = shippedFeatureMandate()
  const initial = mandateAssessmentState(mandated)
  const proposed = { snapshot: initial.snapshot, tier: initial.tier, children: initial.children }
  const prior = assessFixture(mandated, 'negative-replay', initial, proposed, 'editorial')
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
  const replay = { actionId: 'expanded-action', fingerprint: inputs.fingerprint }
  const issue = history([mandated, prior.start, negative, start])
  expect(workflowContextTerminal(issue, 'assess-spec')).toBe('uncertain')
  expect(observeAssessmentContextReplay(issue, start)).toBe('observed')
  expect(observeAssessmentContextReplay(issue, { ...start })).toBe('uncertain')
  expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({ ok: false })
  expect(resolveAcceptedSpec(mandated, [issue], replay)).toMatchObject({ ok: true })
  expect(resolveOwnSpecAuthority(issue, [], new Set(), replay)).toMatchObject({ ok: true })
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
  const other = assessFixture(mandated, 'other-expanded-pending', initial, proposed, 'editorial')
  expect(
    resolveAcceptedSpec(mandated, [history([mandated, prior.start, negative, start, other.start])], replay),
  ).toMatchObject({ ok: false })
})
