import { afterAll, describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { ROXABI_STOP_AUTHOR } from '../../roxabi/github-policy.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { acceptedActionInputs, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlan } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord } from '../record-construction.ts'
import { failedCheckEvidenceDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { reconstructWorkflow } from '../workflow-reconstruction-admission.ts'
import type { SpecializedDecisions } from '../workflow-reconstruction-types.ts'
import { implementationStart, rejectedImplementationResult } from './workflow-implementation-support.ts'
import { binding, facts, history, must, SCOPE } from './workflow-test-support.ts'

const git = nativeImplementationGit(42)
const implementedHead = git.heads[0]
if (implementedHead === undefined) throw new Error('Expected a native implementation commit')
afterAll(() => git.cleanup())
const initialCode = { repository: SCOPE.repository, base: git.p0, head: git.p0, referenceCommit: git.p0 }

const nativeBody = strictSpecBody('ship the bounded workflow')
const parsed = parseIssueSpecBody({ uw: SCOPE, raw: rawSource(SCOPE.target, nativeBody, '2026-10-21T00:00:00Z') })
if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec')
const ownSpec = roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, parsed.snapshot)

async function boundEvidence(issue: DecodedHistory, pullRequest: DecodedHistory, pull: Scope, head: string) {
  const selected = decodeHistory({ ...issue.source, stopAuthor: ROXABI_STOP_AUTHOR })
  const bound = decodeHistory({ ...pullRequest.source, stopAuthor: ROXABI_STOP_AUTHOR })
  const base = git.p0
  const causal = await observeFixtureNativeWorld(
    {
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [selected, bound],
      pullRequests: [
        {
          scope: pull,
          branch: 'feature/bounded',
          base: 'main',
          head,
          baseTip: base,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [
        { repository: SCOPE.repository, sha: base, parents: [] },
        { repository: SCOPE.repository, sha: implementedHead, parents: [base] },
      ],
      comparisons: [
        { repository: SCOPE.repository, base, head: base, status: 'identical', commits: [] },
        { repository: SCOPE.repository, base, head: implementedHead, status: 'ahead', commits: [implementedHead] },
      ],
    },
    { stopAuthor: ROXABI_STOP_AUTHOR },
  )
  return { issue: selected, pullRequest: bound, parents: [], causal }
}
describe('workflow implementation behavior', () => {
  test('does not let an open or rejected implementation bypass confirmation because a pull request exists', async () => {
    const workflow = roxabiWorkflowFixtures()
    const { featureMandate: shippedFeatureMandate } = workflow
    const shipped = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: nativeBody,
      ownSpec,
    })
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const start = implementationStart(shipped, 'act-implement', 'plan-missing', initialCode)
    const rejected = rejectedImplementationResult(shipped, start, 'act-implement', 'plan-missing', initialCode)
    const decisions: SpecializedDecisions = {
      reviewStep: null,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: null,
      publish: { status: 'absent', evidence: [] },
      landing: { status: 'absent', evidence: [] },
      watch: { status: 'absent', evidence: [] },
    }
    const shippedFacts = facts({
      candidateGitSHA: implementedHead,
      productVersion: shipped.payload.config.productVersion,
      configVersion: shipped.payload.config.version,
      configDigest: shipped.payload.config.digest,
      supportedConfigVersions: [shipped.payload.config.version],
      pullRequest: { scope: pull, head: 'feature/bounded', base: 'main', associatedIssue: SCOPE },
    })
    const bound = history([binding(shipped, pull)], pull)
    const open = reconstructWorkflow({
      evidence: await boundEvidence(history([shipped, start]), bound, pull, implementedHead),
      facts: shippedFacts,
      decisions,
    })
    expect(open).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    const rejectedDecision = reconstructWorkflow({
      evidence: await boundEvidence(history([shipped, start, rejected]), bound, pull, implementedHead),
      facts: shippedFacts,
      decisions,
    })
    expect(rejectedDecision).toMatchObject({ status: 'blocked', reason: 'unconfirmed' })
    const ready = history(eligiblePlan(shipped, [history([shipped])], undefined, undefined, initialCode))
    const seed = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: nativeBody,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [ready],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    if (seed.observation.graph.status !== 'complete') throw new Error('Expected a complete native graph')
    const admitted = await nativeImplementationWorld({
      graph: seed.observation.graph,
      histories: [ready],
      scope: SCOPE,
      mandate: shipped,
      author: 'operator',
      startHead: git.p0,
      head: implementedHead,
      baseTip: git.p0,
      remoteTipBefore: git.p0,
      remoteTipAfter: implementedHead,
      pullRequestsBefore: [],
      pullRequestsAfter: [],
      comparisons: [],
      commits: [
        {
          sha: git.p0,
          parents: [],
          tree: git.tree(git.p0),
          subject: 'fixture base',
          paths: ['fixture.txt'],
          config: null,
        },
        {
          sha: implementedHead,
          parents: [git.p0],
          tree: git.tree(implementedHead),
          subject: 'feat: implement fixture (#42)',
          paths: ['fixture.txt'],
          config: null,
        },
      ],
      branch: 'feature/bounded',
      command: 'bun test',
      output: 'PASS',
    })
    const adopted = reconstructWorkflow({
      evidence: await boundEvidence(admitted.history, bound, pull, implementedHead),
      facts: shippedFacts,
      decisions: { ...decisions, publish: { status: 'published', evidence: [] } },
    })
    expect(adopted).toMatchObject({ status: 'action', action: 'review' })
    expect(history([shipped]).operations.some((operation) => operation.record?.kind === 'action-receipt')).toBe(false)
    const nativeOnly = reconstructWorkflow({
      evidence: await boundEvidence(history([shipped]), history([], pull), pull, implementedHead),
      facts: shippedFacts,
      decisions,
    })
    expect(nativeOnly).toMatchObject({ status: 'action', action: 'plan' })
    expect(nativeOnly).not.toMatchObject({ status: 'action', action: 'review' })
  })
  test('retains an unmatched CI attribution when the current candidate changes', async () => {
    const { featureMandate: shippedFeatureMandate } = roxabiWorkflowFixtures()
    const shipped = shippedFeatureMandate(SCOPE, {
      recordId: 'mandate-1',
      runId: 'run-1',
      operationId: 'op-mandate-1',
      branch: 'feature/bounded',
      base: 'main',
      lineageHead: null,
      body: nativeBody,
      ownSpec,
    })
    if (shipped.kind !== 'mandate') throw new Error('expected a mandate')
    const pull: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const oldCandidate = implementedHead
    const currentCandidate = git.p0
    const oldFailure = {
      name: 'old-check',
      source: 'check-run',
      observationId: 'old-observation',
      conclusion: 'failure',
    }
    const currentFailure = {
      name: 'current-check',
      source: 'check-run',
      observationId: 'current-observation',
      conclusion: 'failure',
    }
    const oldDigest = failedCheckEvidenceDigest({
      candidateGitSHA: oldCandidate,
      scope: pull,
      failures: [oldFailure],
    })
    const currentDigest = failedCheckEvidenceDigest({
      candidateGitSHA: currentCandidate,
      scope: pull,
      failures: [currentFailure],
    })
    if (oldDigest === null || currentDigest === null) throw new Error('expected CI evidence digests')
    const exactInputs = {
      candidateGitSHA: oldCandidate,
      scope: pull,
      failedChecks: [oldFailure.name],
      evidenceDigest: oldDigest,
      failures: [oldFailure],
    }
    const baseInputs = acceptedActionInputs(shipped, 'attribute-ci')
    const manifest = {
      ...baseInputs.manifest,
      code: { ...baseInputs.manifest.code, base: git.p0, head: oldCandidate, referenceCommit: git.p0 },
      operands: { action: 'attribute-ci' as const, exactInputs },
    }
    const inputs = { ...baseInputs, manifest, fingerprint: actionInputDigest(manifest) }
    const staleStart = must(
      buildRecord({
        version: 1,
        repository: SCOPE.repository,
        target: SCOPE.target,
        recordId: 'attribute-ci-old-start',
        runId: 'run-1',
        operationId: 'op-attribute-ci-old-start',
        kind: 'action-receipt',
        payload: {
          format: ACTION_RECEIPT_FORMAT,
          inputs,
          phase: 'start',
          action: 'attribute-ci',
          actionId: 'act-attribute-ci-old',
          mandate: { scope: SCOPE, recordId: shipped.recordId, kind: 'mandate' },
          exactInputs,
        },
      }),
    )
    const decision = reconstructWorkflow({
      evidence: await boundEvidence(
        history([shipped, staleStart]),
        history([binding(shipped, pull)], pull),
        pull,
        currentCandidate,
      ),
      facts: facts({
        candidateGitSHA: currentCandidate,
        productVersion: shipped.payload.config.productVersion,
        configVersion: shipped.payload.config.version,
        configDigest: shipped.payload.config.digest,
        supportedConfigVersions: [shipped.payload.config.version],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [currentFailure.name],
        evidenceDigest: currentDigest,
      }),
      decisions: {
        reviewStep: 'fix',
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'red',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(decision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
    const greenDecision = reconstructWorkflow({
      evidence: await boundEvidence(
        history([shipped, staleStart]),
        history([binding(shipped, pull)], pull),
        pull,
        currentCandidate,
      ),
      facts: facts({
        candidateGitSHA: currentCandidate,
        productVersion: shipped.payload.config.productVersion,
        configVersion: shipped.payload.config.version,
        configDigest: shipped.payload.config.digest,
        supportedConfigVersions: [shipped.payload.config.version],
        pullRequest: { scope: pull, head: currentCandidate, base: 'main', associatedIssue: SCOPE },
        failedChecks: [],
        evidenceDigest: null,
      }),
      decisions: {
        reviewStep: null,
        epicStep: null,
        epicLand: null,
        ciWatchStatus: 'green',
        publish: { status: 'absent', evidence: [] },
        landing: { status: 'absent', evidence: [] },
        watch: { status: 'absent', evidence: [] },
      },
    })
    expect(greenDecision).toMatchObject({ status: 'blocked', reason: 'action-uncertain' })
  })
})
