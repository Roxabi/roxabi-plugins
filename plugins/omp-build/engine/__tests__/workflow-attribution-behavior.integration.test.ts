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
import { planOutputSchema, planReviewSchema } from '../workflow-output-schema.ts'
import { planMacro } from '../workflow-plan-macro.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { BODY, history, mandate, must, SCOPE } from './workflow-test-support.ts'

const git = nativeImplementationGit(42)
afterAll(() => git.cleanup())

describe('workflow CI attribution behavior', () => {
  test('binds attribution receipts to a candidate and its actual CI observation', async () => {
    const built = mandate()
    const body = strictSpecBody(BODY)
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
    const mandated = parsed
    const pr = { repository: 'acme/app', target: 'acme/app#99' }
    const candidate = git.p0
    const issue = history([mandated])
    const nativeEvidence = async (pullRequest: DecodedHistory | null) => {
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
        histories: [issue, ...(pullRequest === null ? [] : [pullRequest])],
        pullRequests:
          pullRequest === null
            ? []
            : [
                {
                  scope: pr,
                  branch: 'feature/bounded',
                  base: 'main',
                  head: candidate,
                  baseTip: candidate,
                  state: 'OPEN',
                  mergeCommit: null,
                  author: 'operator',
                },
              ],
        commits: pullRequest === null ? [] : [{ repository: SCOPE.repository, sha: candidate, parents: [] }],
        comparisons: [
          { repository: SCOPE.repository, base: candidate, head: candidate, status: 'identical', commits: [] },
        ],
      })
      return { issue, pullRequest, parents: [], causal }
    }
    const step = {
      id: 'step-1',
      change: 'bind the check',
      doneWhen: 'the check is green',
      criterionIds: ['C1'],
      evidence: 'the captured command',
      paths: ['plugins/omp-build/engine/workflow-plan-macro.ts'],
    }
    expect(planOutputSchema.safeParse({ steps: [], resolutions: [] }).success).toBe(false)
    expect(planOutputSchema.safeParse({ steps: [step], resolutions: [] }).success).toBe(true)
    expect(
      planReviewSchema.safeParse({
        outcome: 'blocking',
        blockers: [
          { id: 'same', criterionId: 'C1', gap: 'missing' },
          { id: 'same', criterionId: 'C1', gap: 'missing' },
        ],
      }).success,
    ).toBe(false)
    expect(planMacro(await nativeEvidence(null), mandated).phase).toBe('needs-draft')
    const failure = {
      name: 'test',
      source: 'ci',
      observationId: 'check-11',
      conclusion: 'FAILURE',
    }
    const rerun = { ...failure, observationId: 'check-12' }
    const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA: candidate, scope: pr, failures: [failure] })
    if (evidenceDigest === null) throw new Error('expected a check evidence digest')
    expect(failedCheckEvidenceDigest({ candidateGitSHA: candidate, scope: pr, failures: [rerun] })).not.toBe(
      evidenceDigest,
    )
    const exactInputs = {
      candidateGitSHA: candidate,
      scope: pr,
      failedChecks: ['test'],
      evidenceDigest,
      failures: [failure],
    }
    const rerunDigest = failedCheckEvidenceDigest({ candidateGitSHA: candidate, scope: pr, failures: [rerun] })
    if (rerunDigest === null) throw new Error('expected a rerun check evidence digest')
    const rerunInputs = {
      ...exactInputs,
      evidenceDigest: rerunDigest,
      failures: [rerun],
    }
    const bind = (exact: typeof exactInputs) => {
      const inputs = acceptedActionInputs(mandated, 'attribute-ci')
      const manifest = {
        ...inputs.manifest,
        code: { ...inputs.manifest.code, base: candidate, head: candidate, referenceCommit: candidate },
        operands: { action: 'attribute-ci' as const, exactInputs: exact },
      }
      return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
    }
    expect(
      parseRecord({
        version: 1,
        repository: pr.repository,
        target: pr.target,
        recordId: 'ci-names',
        runId: 'run-1',
        operationId: 'op-ci-names',
        inputs: [],
        kind: 'action-receipt',
        payload: {
          format: ACTION_RECEIPT_FORMAT,
          inputs: bind(exactInputs),
          phase: 'result',
          action: 'attribute-ci',
          actionId: 'act-ci-names',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: pr, recordId: 'ci-start', kind: 'action-receipt' },
          exactInputs: { candidateGitSHA: 'abc', scope: pr, failedChecks: ['test'] },
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { attribution: 'change', evidence: null },
          admission: null,
          diagnostics: [],
        },
      }).ok,
    ).toBe(false)
    const receipt = must(
      buildRecord({
        version: 1,
        repository: pr.repository,
        target: pr.target,
        recordId: 'ci-1',
        runId: 'run-1',
        operationId: 'op-ci-1',
        kind: 'action-receipt',
        payload: {
          format: ACTION_RECEIPT_FORMAT,
          inputs: bind(exactInputs),
          phase: 'result',
          action: 'attribute-ci',
          actionId: 'act-ci-1',
          mandate: { scope: SCOPE, recordId: mandated.recordId, kind: 'mandate' },
          start: { scope: pr, recordId: 'ci-start', kind: 'action-receipt' },
          exactInputs,
          native: { completion: 'completed', strict: 'valid', raw: null },
          structured: { attribution: 'change', evidence: null },
          admission: null,
          diagnostics: [],
        },
      }),
    )
    expect(parseRecord({ ...receipt, payload: { ...receipt.payload, exactInputs: rerunInputs } }).ok).toBe(false)
  })
})
