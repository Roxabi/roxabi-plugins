import { afterAll, describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { classifyAttempts } from '../workflow-action-interruption.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { appendRecords, interruptedResult, interruptionResolution } from './workflow-interruption-support.ts'
import { BODY, binding, history, mandate, must, pauseControls, SCOPE } from './workflow-test-support.ts'

const git = nativeImplementationGit(42)
afterAll(() => git.cleanup())

const PR = { repository: 'acme/app', target: 'acme/app#99' }
const body = strictSpecBody(BODY)
function attributionMandate() {
  const built = mandate()
  const parsedSpec = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T00:00:00Z') })
  if (parsedSpec.status !== 'conformant') throw new Error('Expected a conformant native Spec')
  const parsed = must(
    parseRecord({
      ...built,
      payload: {
        ...built.payload,
        ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, parsedSpec.snapshot),
      },
    }),
  )
  if (parsed.kind !== 'mandate') throw new Error('expected a mandate')
  return parsed
}

function attributionWorld() {
  const mandated = attributionMandate()
  const candidate = git.p0
  const failure = { name: 'test', source: 'ci', observationId: 'check-11', conclusion: 'FAILURE' }
  const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA: candidate, scope: PR, failures: [failure] })
  if (evidenceDigest === null) throw new Error('expected a check evidence digest')
  const exactInputs = {
    candidateGitSHA: candidate,
    scope: PR,
    failedChecks: ['test'],
    evidenceDigest,
    failures: [failure],
  }
  const base = acceptedActionInputs(mandated, 'attribute-ci')
  const manifest = {
    ...base.manifest,
    code: { ...base.manifest.code, base: candidate, head: candidate, referenceCommit: candidate },
    operands: { action: 'attribute-ci' as const, exactInputs },
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const mandateRef = { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' as const }
  const start = must(
    buildRecord({
      version: 1,
      repository: PR.repository,
      target: PR.target,
      recordId: 'ci-start',
      runId: 'run-1',
      operationId: 'op-ci-start',
      kind: 'action-receipt',
      payload: {
        format: ACTION_RECEIPT_FORMAT,
        inputs,
        phase: 'start',
        action: 'attribute-ci',
        actionId: 'act-ci-1',
        mandate: mandateRef,
        exactInputs,
      },
    }),
  )
  const completed = must(
    buildRecord({
      version: 1,
      repository: PR.repository,
      target: PR.target,
      recordId: 'ci-1',
      runId: 'run-1',
      operationId: 'op-ci-1',
      kind: 'action-receipt',
      payload: {
        format: ACTION_RECEIPT_FORMAT,
        inputs,
        phase: 'result',
        action: 'attribute-ci',
        actionId: 'act-ci-1',
        mandate: mandateRef,
        start: { scope: PR, recordId: 'ci-start', kind: 'action-receipt' },
        exactInputs,
        native: { completion: 'completed', strict: 'valid', raw: null },
        structured: { attribution: 'change', evidence: null },
        admission: null,
        diagnostics: [],
      },
    }),
  )
  const classify = (issue: DecodedHistory, pullRequest: DecodedHistory) =>
    classifyAttempts({ histories: [issue, pullRequest], scan: [pullRequest], actions: ['attribute-ci'] })
  return { mandated, start, interrupted: interruptedResult(completed), classify }
}

describe('interrupted CI attribution', () => {
  test.each([
    ['invalid output', 'attribute-ci-output-invalid', 'invalid'],
    ['withheld execution', 'action-uncertain', 'valid'],
  ] as const)('does not classify retained %s as an interruption', (_name, code, strict) => {
    const world = attributionWorld()
    const terminal = interruptedResult(world.interrupted, {
      native: { completion: 'completed', strict, raw: null },
      diagnostics: [{ code, message: code }],
    })
    const attempts = world.classify(
      history([world.mandated]),
      history([binding(world.mandated, PR), world.start, terminal], PR),
    )
    expect(attempts).toMatchObject({ ok: true, value: { unresolved: [] } })
  })

  test('classifies an interrupted attribution in PR history', () => {
    const world = attributionWorld()
    const attempts = world.classify(
      history([world.mandated]),
      history([binding(world.mandated, PR), world.start, world.interrupted], PR),
    )
    expect(attempts).toMatchObject({
      ok: true,
      value: { unresolved: [{ kind: 'interrupted', action: 'attribute-ci' }] },
    })
  })

  test.each(['competing starts', 'competing results'] as const)(
    'refuses ambiguous interrupted attribution pairing with %s',
    (ambiguity) => {
      const world = attributionWorld()
      const competing =
        ambiguity === 'competing starts'
          ? must(buildRecord({ ...world.start, recordId: 'ci-start-other', operationId: 'op-ci-start-other' }))
          : must(buildRecord({ ...world.interrupted, recordId: 'ci-result-other', operationId: 'op-ci-result-other' }))
      const pullRequest = history([binding(world.mandated, PR), world.start, world.interrupted, competing], PR)
      expect(world.classify(history([world.mandated]), pullRequest)).toMatchObject({ ok: false })
    },
  )

  test('fails closed on a PR-scoped resolution whose runtime differs from the mandate', () => {
    const world = attributionWorld()
    const pause = pauseControls(world.mandated, 'attribution-pause')
    const resolution = interruptionResolution({
      mandate: world.mandated,
      pause: pause.confirmed,
      start: world.start,
      result: world.interrupted,
      proposal: (proposal) => ({
        ...proposal,
        runtime: { ...(proposal.runtime as Record<string, unknown>), configDigest: '0'.repeat(64) },
      }),
    })
    const attempts = world.classify(
      history([world.mandated, pause.requested, pause.confirmed, pause.resumed]),
      appendRecords(history([binding(world.mandated, PR), world.start, world.interrupted], PR), [resolution]),
    )
    expect(attempts).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'interruption-resolution-invalid' })]),
    })
  })

  test('excludes attribution after a PR-scoped resolution under the mandate pause', () => {
    const world = attributionWorld()
    const pause = pauseControls(world.mandated, 'attribution-pause')
    const resolution = interruptionResolution({
      mandate: world.mandated,
      pause: pause.confirmed,
      start: world.start,
      result: world.interrupted,
    })
    const pullRequest = appendRecords(history([binding(world.mandated, PR), world.start, world.interrupted], PR), [
      resolution,
    ])
    expect(world.classify(history([world.mandated, pause.requested, pause.confirmed]), pullRequest)).toMatchObject({
      ok: true,
      value: { unresolved: [] },
    })
  })
})
