import { afterAll, describe, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { acceptedActionInputs, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import {
  appendRecords,
  evidenceCodes,
  interruptedResult,
  interruptionResolution,
} from './workflow-interruption-support.ts'
import { BODY, binding, facts, history, mandate, must, pauseControls, SCOPE } from './workflow-test-support.ts'

const git = nativeImplementationGit(42)
afterAll(() => git.cleanup())

const PR = { repository: 'acme/app', target: 'acme/app#99' }
const body = strictSpecBody(BODY)
const decisions = {
  reviewStep: 'fix-ci' as const,
  epicStep: null,
  epicLand: null,
  ciWatchStatus: 'red' as const,
  publish: { status: 'not-applicable' as const, evidence: [] },
  landing: { status: 'not-applicable' as const, evidence: [] },
  watch: { status: 'not-applicable' as const, evidence: [] },
}

function attributionMandate() {
  const built = mandate()
  const parsedSpec = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, body, '2026-10-21T00:00:00Z') })
  if (parsedSpec.status !== 'conformant') throw new Error('Expected a conformant native Spec')
  const graph = {
    version: 1,
    productVersion: built.payload.config.productVersion,
    configVersion: built.payload.config.version,
    edgeOrder: 'array',
    nodes: [
      { id: 'ready', action: 'stop' },
      { id: 'attribute-ci', action: 'attribute-ci' },
      { id: 'fix', action: 'fix' },
      { id: 'stop', action: 'stop' },
    ],
    edges: [
      { from: 'ready', to: 'attribute-ci', when: 'ci-red' },
      { from: 'ready', to: 'fix', when: 'ci-attributed-change' },
      { from: 'ready', to: 'stop', when: 'ci-attribution-refused' },
      { from: 'ready', to: 'fix', when: 'review-step-fix' },
      { from: 'ready', to: 'stop', when: 'review-step-stop' },
    ],
    initial: 'ready',
  }
  const parsed = must(
    parseRecord({
      ...built,
      payload: {
        ...built.payload,
        ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, parsedSpec.snapshot),
        config: { ...built.payload.config, effective: { graph } },
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
  const decide = async (issue: DecodedHistory, pullRequest: DecodedHistory, explicitResume = false) => {
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue, pullRequest],
      pullRequests: [
        {
          scope: PR,
          branch: 'feature/bounded',
          base: 'main',
          head: candidate,
          baseTip: candidate,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: candidate, parents: [] }],
      comparisons: [
        { repository: SCOPE.repository, base: candidate, head: candidate, status: 'identical', commits: [] },
      ],
    })
    return reconstructWorkflow({
      evidence: { issue, pullRequest, parents: [], causal },
      facts: facts({
        candidateGitSHA: candidate,
        explicitResume,
        pullRequest: { scope: PR, head: candidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: ['test'],
        evidenceDigest,
      }),
      decisions,
    })
  }
  return { mandated, start, interrupted: interruptedResult(completed), decide }
}

describe('interrupted CI attribution', () => {
  test.each([
    ['invalid output', 'attribute-ci-output-invalid', 'invalid'],
    ['withheld execution', 'action-uncertain', 'valid'],
  ] as const)('does not replay attribution after a retained %s terminal', async (_name, code, strict) => {
    const world = attributionWorld()
    const terminal = interruptedResult(world.interrupted, {
      native: { completion: 'completed', strict, raw: null },
      diagnostics: [{ code, message: code }],
    })
    const decision = await world.decide(
      history([world.mandated]),
      history([binding(world.mandated, PR), world.start, terminal], PR),
    )
    expect(decision.status).toBe('blocked')
    expect(decision).not.toMatchObject({ status: 'action', action: 'attribute-ci' })
  })

  test('blocks an interrupted attribution instead of rerunning it', async () => {
    const world = attributionWorld()
    const decision = await world.decide(
      history([world.mandated]),
      history([binding(world.mandated, PR), world.start, world.interrupted], PR),
    )
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-interrupted' })
    expect(decision).not.toMatchObject({ status: 'action' })
  })

  test.each(['competing starts', 'competing results'] as const)(
    'does not rerun or explicitly resume with %s for an interrupted attribution',
    async (ambiguity) => {
      const world = attributionWorld()
      const competing =
        ambiguity === 'competing starts'
          ? must(buildRecord({ ...world.start, recordId: 'ci-start-other', operationId: 'op-ci-start-other' }))
          : must(buildRecord({ ...world.interrupted, recordId: 'ci-result-other', operationId: 'op-ci-result-other' }))
      const pullRequest = history([binding(world.mandated, PR), world.start, world.interrupted, competing], PR)
      const running = await world.decide(history([world.mandated]), pullRequest)
      expect(running).toMatchObject({ status: 'blocked' })
      expect(running).not.toMatchObject({ status: 'action', action: 'attribute-ci' })
      const pause = pauseControls(world.mandated, `ci-${ambiguity.replace(' ', '-')}`)
      const paused = history([world.mandated, pause.requested, pause.confirmed])
      const resume = await world.decide(paused, pullRequest, true)
      expect(resume).toMatchObject({ status: 'blocked' })
      expect(resume).not.toMatchObject({ status: 'action', action: 'resume' })
    },
  )

  test('fails closed on a PR-scoped resolution whose runtime differs from the mandate', async () => {
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
    const decision = await world.decide(
      history([world.mandated, pause.requested, pause.confirmed, pause.resumed]),
      appendRecords(history([binding(world.mandated, PR), world.start, world.interrupted], PR), [resolution]),
    )
    expect(decision).toMatchObject({ status: 'blocked', reason: 'interruption-invalid' })
    expect(evidenceCodes(decision)).toContain('interruption-resolution-invalid')
  })

  test('readmits attribution after a PR-scoped resolution under the mandate pause', async () => {
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
    expect(await world.decide(history([world.mandated, pause.requested, pause.confirmed]), pullRequest)).toMatchObject({
      status: 'paused',
      confirmed: true,
    })
    expect(
      await world.decide(history([world.mandated, pause.requested, pause.confirmed, pause.resumed]), pullRequest),
    ).toMatchObject({ status: 'action', action: 'attribute-ci' })
  })
})
