import { describe, expect, test } from 'vitest'
import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { BODY, binding, DIGEST, featureMandate, history, mandate, must, SCOPE } from './workflow-test-support.ts'

describe('workflow bound work behavior', () => {
  test('returns the accepted spec bytes and refuses a malformed or inactive binding', () => {
    const mandated = featureMandate()
    if (mandated.kind !== 'mandate') throw new Error('expected a mandate')
    const current = 'ship the bounded workflow, clarified'
    const acceptedDigest = specDigest(BODY)
    const currentDigest = specDigest(current)
    const receipt = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'assess-1',
        runId: 'run-1',
        operationId: 'op-assess-1',
        kind: 'action-receipt',
        payload: {
          phase: 'result',
          action: 'assess-spec',
          actionId: 'act-assess-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: SCOPE, recordId: 'assess-start', kind: 'action-receipt' },
          exactInputs: { acceptedDigest, currentDigest, acceptedBody: BODY, currentBody: current },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { classification: 'editorial' },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    const start = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'assess-start',
        runId: 'run-1',
        operationId: 'op-assess-start',
        kind: 'action-receipt',
        payload: {
          phase: 'start',
          action: 'assess-spec',
          actionId: 'act-assess-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          exactInputs: { acceptedDigest, currentDigest, acceptedBody: BODY, currentBody: current },
        },
      }),
    )
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const issue = history([mandated, start, receipt])
    const bound = resolveBoundWork({
      use: 'review',
      explicitSelection: true,
      pullRequest: pr,
      histories: [issue, history([binding(mandated, pr)], pr)],
      native,
      currentSpec: { body: current, digest: currentDigest },
    })
    expect(bound).toMatchObject({
      status: 'applicable',
      drift: 'settled',
      permissions: { landing: true, correct: true },
      acceptedSpec: { body: current, digest: currentDigest, reference: 'acme/app#42' },
      configIdentity: { additionalRequirements: [], digest: DIGEST },
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: {
        body: current,
        chain: [{ kind: 'mandate' }, { kind: 'editorial', recordId: 'assess-1' }],
        sourceRefs: [
          { kind: 'mandate', recordId: mandated.recordId },
          { kind: 'action-receipt', recordId: 'assess-1' },
        ],
      },
    })
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([], pr)],
        native,
      }),
    ).toEqual({ status: 'standalone', binding: 'absent' })
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'missing' })
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [history([binding(mandated, pr)], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    const fixOnly = mandate()
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: false,
        pullRequest: pr,
        histories: [history([fixOnly]), history([binding(fixOnly, pr)], pr)],
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'fix-only' })
  })
})
