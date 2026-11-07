import type { Gh } from '../../adapters/github/types.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { OperatorPort, UwOperations } from '../../roxabi/uw-contract.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import type { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import type { DeclaredCheckout } from '../../testing/native-implementation-world.ts'
import { withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlanAt } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import type { Scope, Verdict } from '../record-values.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import type { UwGraphObservation } from '../uw-graph.ts'
import { canonicalSpec } from '../uw-spec.ts'
import type { PlanOutput } from '../workflow-output-schema.ts'
import { buildDeliveredLeaf } from './uw-delivered-leaf-fixture.ts'
import { childReview } from './uw-parent-child-review-fixture.ts'
import { parentCommitFacts } from './uw-parent-commit-fixture.ts'

export async function deliveredLeaf(verdict: Verdict = 'Approve (clean)', number = 42, inherited = false) {
  return buildDeliveredLeaf(verdict, number, inherited)
}
type ParentReview = {
  uw: Scope
  pullRequest: Scope
  branch: string
  binding: ReturnType<ReturnType<typeof roxabiWorkflowFixtures>['workflowBinding']>
  review: ReturnType<typeof criterionReviewGraph>
  head: string
  base: string
  merge: string
}
type ParentDeliveryWorld = {
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
  parent: ReturnType<ReturnType<typeof roxabiWorkflowFixtures>['epicMandate']>
  parentScope: Scope
  reviews: ParentReview[]
  p0: string
  merges: readonly string[]
  heads: readonly string[]
  parentHead: string
  gh: Gh
  git: GitRunner
  operations: UwOperations
  checkout(facts: DeclaredCheckout): void
}

/** A single declared native repository, with three distinct merged child PRs. */
export async function threeDeliveredChildren<T>(
  git: {
    p0: string
    merges: readonly string[]
    heads: readonly string[]
    parentHead: string
    trees: readonly string[]
    baseTrees: readonly string[]
    mergeTrees: readonly string[]
    parentTree: string
    diff: Uint8Array
    cwd?: string
    originUrl?: string
  },
  parentCriteria: Readonly<Parameters<typeof canonicalSpec>[0]['criteria']>,
  initialParentPlan: 'framed' | 'planned',
  use: (world: ParentDeliveryWorld) => Promise<T>,
  operator?: OperatorPort,
): Promise<T> {
  const workflow = roxabiWorkflowFixtures()
  const repository = 'acme/app'
  const parentScope = { repository, target: `${repository}#200` }
  const date = '2026-10-27T12:00:00.000Z'
  const content = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Save keeps the selected region' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  const parentContent = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [...parentCriteria],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!content.ok || !parentContent.ok) throw new Error('Invalid native fixture Spec')
  const body = renderIssueSpecBody(content.value, { complexity: 1 })
  const parentBody = renderIssueSpecBody(parentContent.value, { complexity: 1 })
  const scopes = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))
  const nativeSpec = (scope: typeof parentScope, sourceBody: string) => {
    const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, sourceBody, date) })
    if (parsed.status !== 'conformant') throw new Error(`Invalid framed native Spec for ${scope.target}`)
    return workflow.ownSpecFromSnapshot(scope, parsed.snapshot)
  }
  const nativeChildSpecs = scopes.map((scope) => nativeSpec(scope, body))
  const nativeParentSpec = nativeSpec(parentScope, parentBody)
  const parentSeed = workflow.epicMandate(
    parentScope,
    scopes.map((scope, i) => {
      const spec = nativeChildSpecs[i]
      if (spec === undefined) throw new Error(`Missing child Spec ${i}`)
      return { scope, snapshot: spec.snapshot, specVersion: spec.version, tier: 'S' as const }
    }),
    { recordId: 'parent-mandate', body: parentBody, ownSpec: nativeParentSpec },
  )
  const parent = parentSeed
  const children = scopes.map((scope, i) => {
    const ownSpec = nativeChildSpecs[i]
    if (ownSpec === undefined) throw new Error(`Missing child Spec ${i}`)
    return workflow.featureMandate(scope, {
      body,
      ownSpec,
      recordId: `child-mandate-${i}`,
      branch: `feature/child-${i}`,
      parent: workflow.mandateRef(parent),
      inheritedOwnSpecRefs: [
        { uw: parentScope, version: parent.payload.ownSpec.version, sourceAccepted: workflow.mandateRef(parent) },
      ],
    })
  })
  const graph: Extract<UwGraphObservation, { status: 'complete' }> = {
    status: 'complete',
    root: parentScope,
    observedAt: date,
    nodes: [
      {
        uw: parentScope,
        title: 'Parent',
        raw: nativeParentSpec.snapshot.raw,
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: scopes,
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
      ...scopes.map((uw) => ({
        uw,
        title: uw.target,
        raw: rawSource(uw.target, body, date),
        updatedAt: date,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: parentScope,
        children: [],
        blockers: [],
        native: { state: 'OPEN' as const, stateReason: null },
      })),
    ],
  }
  const { p0, merges, heads } = git
  const [firstMerge, secondMerge, thirdMerge] = merges
  const [firstHead, secondHead, thirdHead] = heads
  const firstBaseTree = git.baseTrees[0]
  if (!firstMerge || !secondMerge || !thirdMerge || !firstHead || !secondHead || !thirdHead || !firstBaseTree)
    throw new Error('Expected three declared child commits and base tree')
  const parentPlan: PlanOutput = {
    steps: parentCriteria.map((criterion) => ({
      id: `integrate-${criterion.id}`,
      change: `Integrate child delivery for ${criterion.id}`,
      doneWhen: criterion.statement,
      criterionIds: [criterion.id],
      evidence: 'The direct Parent integration scenario verifies this obligation',
      paths: ['fixture.txt'],
    })),
    resolutions: [],
  }
  const parentBasis = workflow.historyFrom([parent])
  const parentHistory = workflow.historyFrom(
    initialParentPlan === 'framed' ? [parent] : eligiblePlanAt(parent, p0, [parentBasis], undefined, parentPlan),
  )
  const mandateHistories = children.map((mandate) =>
    workflow.historyFrom([mandate], 'operator', 'operator', [parentHistory]),
  )
  const context = [parentHistory, ...mandateHistories]
  const projection = roxabiRecordFixtures().projection
  const bases = [p0, firstMerge, secondMerge]
  const reviews: Awaited<ReturnType<typeof childReview>>[] = []
  for (const [i, mandate] of children.entries()) {
    reviews.push(
      await childReview({
        mandate,
        i,
        repository,
        scopes,
        heads,
        bases,
        merges,
        git,
        context,
        graph,
        projection,
        workflow,
      }),
    )
  }
  const histories = [parentHistory, ...reviews.flatMap((entry) => [entry.review.issueHistory, entry.review.history])]
  const parentHead = git.parentHead
  const { commits, comparisons } = parentCommitFacts({
    p0,
    parentHead,
    firstBaseTree,
    git,
    reviews,
    merges: [firstMerge, secondMerge, thirdMerge],
    heads: [firstHead, secondHead, thirdHead],
  })
  const pullRequests = reviews.map((entry) => ({
    scope: entry.pullRequest,
    branch: entry.branch,
    base: 'main',
    head: entry.head,
    baseTip: entry.base,
    state: 'MERGED' as const,
    mergeCommit: entry.merge,
    mergedAt: '2026-10-27T12:00:00Z',
    author: 'operator',
  }))
  return withNativeImplementationWorld(
    {
      graph,
      histories,
      commits,
      pullRequests,
      comparisons,
      author: 'operator',
      anchor: parentScope,
      plugin: standaloneReviewInputs().manifest.plugin,
      ...(operator === undefined ? {} : { operator }),
      ...(git.originUrl === undefined ? {} : { originUrl: git.originUrl }),
      checkout: {
        branch: null,
        head: thirdMerge,
        base: 'main',
        baseTip: thirdMerge,
        remoteTip: thirdMerge,
      },
      diffs: [
        { base: thirdMerge, head: parentHead, bytes: git.diff },
        { base: thirdMerge, head: thirdMerge, bytes: new Uint8Array() },
      ],
      ...(git.cwd === undefined ? {} : { cwd: git.cwd }),
    },
    async (native) => {
      const active = git.originUrl === undefined ? native : await native.at(native.cwd)
      const read = await active.operations.readUw(parentScope)
      if (read.observation.status !== 'complete')
        throw new Error(`Parent world observation incomplete: ${JSON.stringify(read.observation.diagnostics)}`)
      return use({
        observation: read.observation,
        parent,
        parentScope,
        reviews,
        p0,
        merges,
        heads,
        parentHead,
        gh: active.gh,
        git: active.git,
        operations: active.operations,
        checkout: active.checkout,
      })
    },
  )
}
