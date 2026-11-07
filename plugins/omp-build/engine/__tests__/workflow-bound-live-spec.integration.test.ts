import { afterAll, expect, test } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import { boundCorrection } from '../../roxabi/fix-mandate-resolution.ts'
import { resolveReviewSemanticContext } from '../../roxabi/review-semantic-context.ts'
import { readCurrentOwnSpecFacts } from '../../roxabi/uw-current-facts.ts'
import { createInstalledObservedUwReadPort } from '../../roxabi/uw-read-port.ts'
import { strictSpecBody } from '../../skills/feature/testing/epic-driver/epic-driver-records.ts'
import { observeFixtureNativeWorld, standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { parseRecord } from '../record-construction.ts'
import type { Scope } from '../record-values.ts'
import { resolveBoundWork } from '../workflow-bound-work-resolution.ts'
import { BODY, binding, featureMandate, history, must, SCOPE } from './workflow-test-support.ts'

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

test('keeps bound review and correction settled after a stable native presentation edit', async () => {
  const mandated = nativeMandate(featureMandate())
  const pr: Scope = { repository: SCOPE.repository, target: 'acme/app#99' }
  const histories = [history([mandated]), history([binding(mandated, pr)], pr)]
  const native = { branch: 'feature/bounded', base: 'main' }
  const acceptedBody = mandated.payload.ownSpec.snapshot.raw.body
  expect(acceptedBody).toBe(nativeBody)
  const observe = (body: string, tier: 'S' | 'F-lite') =>
    observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Bounded workflow',
          body,
          updatedAt: '2026-10-21T00:00:00Z',
          labels: [`size:${tier}`],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories,
      pullRequests: [
        {
          scope: pr,
          branch: native.branch,
          base: native.base,
          head: git.p0,
          baseTip: git.p0,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      commits: [{ repository: SCOPE.repository, sha: git.p0, parents: [] }],
      comparisons: [{ repository: SCOPE.repository, base: git.p0, head: git.p0, status: 'identical', commits: [] }],
    })
  const initial = await observe(acceptedBody, 'S')
  const initialRead = await createInstalledObservedUwReadPort({ observation: initial.observation }).readUw(SCOPE)
  expect(initialRead.admission.deliverable.ok).toBe(true)
  const initialFacts = await readCurrentOwnSpecFacts({ uw: SCOPE, read: initialRead })
  if (!initialFacts.ok) throw new Error('Expected initial current native facts')
  const input = {
    use: 'review' as const,
    explicitSelection: true,
    pullRequest: pr,
    histories,
    native,
  }
  const correction = {
    target: {
      ...pr,
      number: 99,
      kind: 'pull-request' as const,
      state: 'open' as const,
      candidateGitSHA: git.p0,
      baseGitSHA: git.p0,
    },
    ...native,
  }
  expect(resolveBoundWork({ ...input, causal: initial, currentSpec: initialFacts.value.currentSpec })).toMatchObject({
    status: 'applicable',
    drift: 'settled',
  })
  expect(boundCorrection(correction, histories, initialFacts.value.currentSpec, initial)).toMatchObject({
    ok: true,
    value: { status: 'applicable', recordId: mandated.recordId },
  })
  const editorialBody = `${acceptedBody}\n`
  const editorial = await observe(editorialBody, 'S')
  const editorialRead = await createInstalledObservedUwReadPort({ observation: editorial.observation }).readUw(SCOPE)
  expect(editorialRead.admission.deliverable.ok).toBe(true)
  const editorialFacts = await readCurrentOwnSpecFacts({ uw: SCOPE, read: editorialRead })
  if (!editorialFacts.ok) throw new Error('Expected editorial current native facts')
  const current = editorialFacts.value.currentSpec
  expect(current.snapshot.raw.body).toBe(editorialBody)
  expect(current.snapshot.raw.bodySha256).not.toBe(mandated.payload.ownSpec.snapshot.raw.bodySha256)
  expect(current.snapshot.spec.version).toBe(mandated.payload.ownSpec.version)
  expect(current.snapshot.spec.criteria).toEqual(mandated.payload.ownSpec.snapshot.spec.criteria)
  expect(current.tier).toBe('S')
  await withNativeImplementationWorld(
    {
      anchor: SCOPE,
      plugin: standaloneReviewInputs().manifest.plugin,
      author: 'operator',
      graph: initial.observation.graph,
      histories,
      checkout: { branch: native.branch, head: git.p0, base: native.base, baseTip: git.p0, remoteTip: git.p0 },
      commits: [{ sha: git.p0, parents: [], tree: '8'.repeat(40), subject: 'baseline', paths: [], config: null }],
      pullRequests: [
        { scope: pr, ...native, head: git.p0, baseTip: git.p0, state: 'OPEN', mergeCommit: null, author: 'operator' },
      ],
      comparisons: [{ base: git.p0, head: git.p0, status: 'identical', commits: [] }],
      diffs: [],
    },
    async (world) => {
      const request = {
        cwd: world.cwd,
        repository: pr.repository,
        pr: 99,
        ...native,
        gh: world.gh,
        automationLogin: 'operator',
      }
      const baselineReview = await resolveReviewSemanticContext(request)
      expect(baselineReview).toMatchObject({
        ok: true,
        value: { mode: 'bound', acceptedSpec: { body: acceptedBody }, currentSpec: { body: acceptedBody } },
      })
      world.observeGraph(editorial.observation.graph)
      const editorialReview = await resolveReviewSemanticContext(request)
      expect.soft(editorialReview).toMatchObject({
        ok: true,
        value: { mode: 'bound', acceptedSpec: { body: acceptedBody }, currentSpec: { body: editorialBody } },
      })
    },
  )
  expect.soft(resolveBoundWork({ ...input, causal: editorial, currentSpec: current })).toMatchObject({
    status: 'applicable',
    drift: 'settled',
    acceptedSpec: { snapshot: mandated.payload.ownSpec.snapshot },
  })
  expect.soft(boundCorrection(correction, histories, current, editorial)).toMatchObject({
    ok: true,
    value: {
      status: 'applicable',
      recordId: mandated.recordId,
      acceptedSpec: { snapshot: mandated.payload.ownSpec.snapshot },
    },
  })
  const materialBody = acceptedBody.replace(BODY, `${BODY} materially changed`)
  expect(materialBody).not.toBe(acceptedBody)
  const materialSnapshot = nativeSnapshot(SCOPE, materialBody)
  expect(materialSnapshot.spec.version).not.toBe(mandated.payload.ownSpec.version)
  const material = await observe(materialBody, 'S')
  expect(
    resolveBoundWork({
      ...input,
      causal: material,
      currentSpec: { ...current, snapshot: materialSnapshot },
    }),
  ).toMatchObject({ status: 'applicable', drift: 'differs' })
  expect(boundCorrection(correction, histories, { ...current, snapshot: materialSnapshot }, material)).toMatchObject({
    ok: false,
  })
  const tierChanged = await observe(acceptedBody, 'F-lite')
  expect(
    resolveBoundWork({
      ...input,
      causal: tierChanged,
      currentSpec: { ...initialFacts.value.currentSpec, tier: 'F-lite' },
    }),
  ).toMatchObject({ status: 'applicable', drift: 'differs' })
  expect(
    boundCorrection(correction, histories, { ...initialFacts.value.currentSpec, tier: 'F-lite' }, tierChanged),
  ).toMatchObject({ ok: false })
})
