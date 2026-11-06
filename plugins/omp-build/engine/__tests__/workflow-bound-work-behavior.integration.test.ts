import { afterAll, describe, expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { fixtureCausal, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { parseRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { Scope } from '../record-values.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { assessFixture, mandateAssessmentState, proposedAssessmentState } from './workflow-spec-assessment-support.ts'
import { BODY, binding, DIGEST, featureMandate, history, mandate, must, SCOPE } from './workflow-test-support.ts'

const git = nativeImplementationGit(42)
afterAll(() => git.cleanup())

const nativeBody = strictSpecBody(BODY)
function nativeSnapshot(scope: Scope, body: string) {
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, '2026-10-21T00:00:00Z') })
  if (parsed.status !== 'conformant') throw new Error('Expected a conformant declared Spec')
  return parsed.snapshot
}
function nativeMandate(record: ReturnType<typeof featureMandate>) {
  const parsed = must(
    parseRecord({
      ...record,
      payload: {
        ...record.payload,
        ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(SCOPE, nativeSnapshot(SCOPE, nativeBody)),
      },
    }),
  )
  if (parsed.kind !== 'mandate') throw new Error('Expected a mandate')
  return parsed
}
describe('workflow bound work behavior', () => {
  test('returns the exact accepted own Spec and refuses malformed or inactive bindings', async () => {
    const mandated = nativeMandate(featureMandate())
    const current = strictSpecBody('ship the bounded workflow, clarified')
    const accepted = mandateAssessmentState(mandated)
    const currentSpec = nativeSnapshot(SCOPE, current).spec
    const proposed = proposedAssessmentState(accepted, {
      body: current,
      content: {
        criteria: currentSpec.criteria,
        invariants: currentSpec.invariants,
        exclusions: currentSpec.exclusions,
        openQuestions: currentSpec.openQuestions,
        sections: currentSpec.sections,
      },
    })
    const assessment = assessFixture(
      mandated,
      'assess-1',
      accepted,
      proposed,
      'editorial',
      [history([mandated])],
      undefined,
      undefined,
      { repository: SCOPE.repository, base: git.p0, head: git.p0, referenceCommit: git.p0 },
    )
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const issue = history([mandated, assessment.start, assessment.result])
    const boundHistories = [issue, history([binding(mandated, pr)], pr)]
    const code = git.p0
    const causal = await observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body: current,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: boundHistories,
      pullRequests: [
        {
          scope: pr,
          branch: native.branch,
          base: native.base,
          head: code,
          baseTip: code,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: code, parents: [] }],
      comparisons: [{ repository: SCOPE.repository, base: code, head: code, status: 'identical', commits: [] }],
    })
    const bound = resolveBoundWork({
      use: 'review',
      explicitSelection: true,
      pullRequest: pr,
      histories: boundHistories,
      causal,
      native,
      currentSpec: proposed,
    })
    expect(bound).toMatchObject({
      status: 'applicable',
      drift: 'settled',
      permissions: { landing: true, correct: true },
      acceptedSpec: {
        snapshot: assessment.result.payload.exactInputs.proposed.snapshot,
        tier: 'S',
      },
      configIdentity: { additionalRequirements: [], digest: DIGEST },
    })
    expect(resolveAcceptedSpec(mandated, [issue])).toMatchObject({
      ok: true,
      spec: {
        snapshot: assessment.result.payload.exactInputs.proposed.snapshot,
        chain: [{ kind: 'mandate' }, { kind: 'editorial', source: { recordId: 'assess-1' } }],
      },
    })
    const emptyPull = history([], pr)
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [emptyPull],
        causal: fixtureCausal([emptyPull]),
        native,
      }),
    ).toEqual({
      status: 'standalone',
      binding: 'absent',
    })
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: true,
        pullRequest: pr,
        histories: [emptyPull],
        causal: fixtureCausal([emptyPull]),
        native,
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'missing',
    })
    const incompleteBinding = history([binding(mandated, pr)], pr)
    expect(
      resolveBoundWork({
        use: 'review',
        explicitSelection: true,
        pullRequest: pr,
        histories: [incompleteBinding],
        causal: fixtureCausal([incompleteBinding]),
        native,
      }),
    ).toMatchObject({
      status: 'refused',
      reason: 'incomplete',
    })
    const fixOnly = nativeMandate(mandate())
    const fixHistories = [history([fixOnly]), history([binding(fixOnly, pr)], pr)]
    const fixCausal = await observeFixtureNativeWorld({
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
      histories: fixHistories,
      pullRequests: [
        {
          scope: pr,
          branch: native.branch,
          base: native.base,
          head: code,
          baseTip: code,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: code, parents: [] }],
      comparisons: [],
    })
    expect(
      resolveBoundWork({
        use: 'landing',
        explicitSelection: false,
        pullRequest: pr,
        histories: fixHistories,
        causal: fixCausal,
        native,
      }),
    ).toMatchObject({ status: 'refused', reason: 'fix-only' })
  })
  test('foreign binding observations cannot compete with bound or standalone review', async () => {
    const mandated = nativeMandate(featureMandate())
    const pr: Scope = { repository: 'acme/app', target: 'acme/app#99' }
    const native = { branch: 'feature/bounded', base: 'main' }
    const boundHistory = history([binding(mandated, pr)], pr)
    const noisy = decodeHistory({
      ...boundHistory.source,
      comments: [
        ...boundHistory.source.comments,
        ...boundHistory.source.comments.map((comment, index) => ({
          ...comment,
          locator: `${pr.target}:comment:${index + 1001}`,
          nativeId: String(index + 1001),
          author: 'stranger',
        })),
      ],
    })
    const input = { explicitSelection: true, pullRequest: pr, native }
    const noisyHistories = [history([mandated]), noisy]
    const code = git.p0
    const causal = await observeFixtureNativeWorld({
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
      histories: noisyHistories,
      pullRequests: [
        {
          scope: pr,
          branch: native.branch,
          base: native.base,
          head: code,
          baseTip: code,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: code, parents: [] }],
      comparisons: [],
    })
    expect(resolveBoundWork({ ...input, use: 'review', histories: noisyHistories, causal })).toMatchObject({
      status: 'applicable',
    })
    const foreignOnly = decodeHistory({
      ...boundHistory.source,
      comments: boundHistory.source.comments.map((comment) => ({ ...comment, author: 'stranger' })),
    })
    expect(
      resolveBoundWork({ ...input, use: 'review', histories: [foreignOnly], causal: fixtureCausal([foreignOnly]) }),
    ).toMatchObject({ status: 'refused', reason: 'incomplete' })
    expect(
      resolveBoundWork({ ...input, use: 'landing', histories: [foreignOnly], causal: fixtureCausal([foreignOnly]) }),
    ).toMatchObject({
      status: 'refused',
      reason: 'incomplete',
    })
  })
  test('ignores child read-date drift while preserving canonical child drift detection', async () => {
    const fixtures = roxabiWorkflowFixtures()
    const child: Scope = { repository: SCOPE.repository, target: 'acme/app#43' }
    const childBody = strictSpecBody('child C1')
    const childSnapshot = nativeSnapshot(child, childBody)
    const mandated = fixtures.epicMandate(
      SCOPE,
      [{ scope: child, snapshot: childSnapshot, specVersion: childSnapshot.spec.version, tier: 'S' }],
      {
        recordId: 'epic-bound',
        runId: 'bound001',
        operationId: 'op-epic-bound',
        body: nativeBody,
        ownSpec: fixtures.ownSpecFromSnapshot(SCOPE, nativeSnapshot(SCOPE, nativeBody)),
      },
    )
    const accepted = mandateAssessmentState(mandated)
    const content = {
      criteria: accepted.snapshot.spec.criteria,
      invariants: accepted.snapshot.spec.invariants,
      exclusions: accepted.snapshot.spec.exclusions,
      openQuestions: accepted.snapshot.spec.openQuestions,
      sections: accepted.snapshot.spec.sections,
    }
    const commitment = accepted.children[0]
    if (commitment === undefined) throw new Error('fixture epic has no child commitment')
    const pr: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
    const histories = [history([mandated]), history([binding(mandated, pr)], pr)]
    const code = git.p0
    const childCausal = async (observedBody: string, tier: 'S' | 'F-lite', updatedAt: string) =>
      observeFixtureNativeWorld({
        root: SCOPE,
        nodes: [
          {
            scope: SCOPE,
            title: 'Bounded workflow',
            body: nativeBody,
            updatedAt: '2026-10-21T00:00:00Z',
            labels: ['size:S'],
            parent: null,
            children: [child],
            blockers: [],
            state: 'OPEN',
            stateReason: null,
          },
          {
            scope: child,
            title: 'Child work',
            body: observedBody,
            updatedAt,
            labels: [`size:${tier}`],
            parent: SCOPE,
            children: [],
            blockers: [],
            state: 'OPEN',
            stateReason: null,
          },
        ],
        histories: [...histories, history([], child)],
        pullRequests: [
          {
            scope: pr,
            branch: 'feature/bounded',
            base: 'main',
            head: code,
            baseTip: code,
            state: 'OPEN',
            mergeCommit: null,
            author: 'operator',
          },
        ],
        commits: [{ repository: SCOPE.repository, sha: code, parents: [] }],
        comparisons: [],
      })
    const input = {
      use: 'review' as const,
      explicitSelection: true,
      pullRequest: pr,
      histories,
      causal: await childCausal(childBody, 'S', '2026-10-22T00:00:00Z'),
      native: { branch: 'feature/bounded', base: 'main' },
    }
    const datedOnly = proposedAssessmentState(accepted, {
      body: nativeBody,
      content,
      children: [
        {
          ...commitment,
          snapshot: {
            ...commitment.snapshot,
            raw: { ...commitment.snapshot.raw, lastEditedAt: '2026-10-22T00:00:00Z' },
          },
        },
      ],
    })
    expect(resolveBoundWork({ ...input, currentSpec: datedOnly })).toMatchObject({
      status: 'applicable',
      drift: 'settled',
    })
    const childC2Body = strictSpecBody('child C2')
    const childC2 = nativeSnapshot(child, childC2Body)
    const childVersionChanged = proposedAssessmentState(accepted, {
      body: nativeBody,
      content,
      children: [{ scope: child, snapshot: childC2, specVersion: childC2.spec.version, tier: 'S' }],
    })
    expect(
      resolveBoundWork({
        ...input,
        causal: await childCausal(childC2Body, 'S', '2026-10-21T00:00:00Z'),
        currentSpec: childVersionChanged,
      }),
    ).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
    const childTierChanged = proposedAssessmentState(accepted, {
      body: nativeBody,
      content,
      children: [{ ...commitment, tier: 'F-lite' }],
    })
    expect(
      resolveBoundWork({
        ...input,
        causal: await childCausal(childBody, 'F-lite', '2026-10-21T00:00:00Z'),
        currentSpec: childTierChanged,
      }),
    ).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
    const changedRawBody = 'child C1 rewritten'
    const childRawChanged = proposedAssessmentState(accepted, {
      body: nativeBody,
      content,
      children: [
        {
          ...commitment,
          snapshot: {
            ...commitment.snapshot,
            raw: {
              ...commitment.snapshot.raw,
              body: changedRawBody,
              bodySha256: specDigest(changedRawBody),
            },
          },
        },
      ],
    })
    expect(
      resolveBoundWork({
        ...input,
        causal: await childCausal(changedRawBody, 'S', '2026-10-21T00:00:00Z'),
        currentSpec: childRawChanged,
      }),
    ).toMatchObject({
      status: 'applicable',
      drift: 'differs',
    })
  })
})
