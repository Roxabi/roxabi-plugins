import type { Gh } from '../../adapters/github/types.ts'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { OperatorPort, UwOperations } from '../../roxabi/uw-contract.ts'
import type { GitRunner } from '../../roxabi/workflow-checkout.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import type { criterionReviewGraph } from '../../testing/criterion-approval.ts'
import type { DeclaredCheckout } from '../../testing/native-implementation-world.ts'
import { withNativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { eligiblePlanAt } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { Scope, Verdict } from '../record-values.ts'
import type { UwCompletionObservation } from '../uw-completion-types.ts'
import type { UwGraphObservation } from '../uw-graph.ts'
import type { canonicalSpec } from '../uw-spec.ts'
import type { PlanOutput } from '../workflow-output-schema.ts'
import { buildDeliveredLeaf } from './uw-delivered-leaf-fixture.ts'
import { childReview } from './uw-parent-child-review-fixture.ts'
import { parentCommitFacts } from './uw-parent-commit-fixture.ts'
import { emptyDeliveryHistory, parentDeliveryInventory } from './uw-parent-inventory-fixture.ts'
import { deliverySpecBodies, deliverySpecSnapshot } from './uw-parent-spec-fixture.ts'
import { completeDeliveryWorld } from './uw-parent-world-fixture.ts'

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
export type ParentDeliveryWorld = {
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
  parent: ReturnType<ReturnType<typeof roxabiWorkflowFixtures>['epicMandate']>
  parentScope: Scope
  reviews: ParentReview[]
  p0: string
  merges: readonly string[]
  heads: readonly string[]
  parentHead: string
  gh: Gh
  ghSync(cwd: string, args: string[]): string
  git: GitRunner
  operations: UwOperations
  checkout(facts: DeclaredCheckout): void
  observeGraph(graph: Extract<UwGraphObservation, { status: 'complete' }>): void
  at: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]['at']
  observeEpic: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]['observeEpic']
  observePullRequest: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]['observePullRequest']
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
    repositoryFiles?: Parameters<typeof withNativeImplementationWorld>[0]['repositoryFiles']
  },
  parentCriteria: Readonly<Parameters<typeof canonicalSpec>[0]['criteria']>,
  initialParentPlan: 'framed' | 'planned',
  use: (world: ParentDeliveryWorld) => Promise<T>,
  operator?: OperatorPort,
  selectedParent?: { mandate: ParentDeliveryWorld['parent']; history: DecodedHistory },
  selectParentInWorld?: (
    world: Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0],
    parent: ParentDeliveryWorld['parent'],
  ) => Promise<{ mandate: ParentDeliveryWorld['parent']; history: DecodedHistory }>,
): Promise<T> {
  const workflow = roxabiWorkflowFixtures()
  const repository = 'acme/app'
  const parentScope = { repository, target: `${repository}#200` }
  const date = '2026-10-27T12:00:00.000Z'
  const { body, parentBody } = deliverySpecBodies(
    parentCriteria,
    selectedParent?.mandate.payload.ownSpec.snapshot.raw.body,
  )
  const scopes = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))
  const nativeSpec = (scope: typeof parentScope, sourceBody: string) =>
    workflow.ownSpecFromSnapshot(scope, deliverySpecSnapshot(scope, sourceBody, date))
  const nativeChildSpecs = scopes.map((scope) => nativeSpec(scope, body))
  const nativeParentSpec = nativeSpec(parentScope, parentBody)
  const parent =
    selectedParent?.mandate ??
    workflow.epicMandate(
      parentScope,
      scopes.map((scope, i) => {
        const spec = nativeChildSpecs[i]
        if (spec === undefined) throw new Error(`Missing child Spec ${i}`)
        return { scope, snapshot: spec.snapshot, specVersion: spec.version, tier: 'S' as const }
      }),
      { recordId: 'parent-mandate', body: parentBody, ownSpec: nativeParentSpec },
    )
  const childrenFor = (selected: ParentDeliveryWorld['parent']) =>
    scopes.map((scope, i) => {
      const ownSpec = nativeChildSpecs[i]
      if (ownSpec === undefined) throw new Error(`Missing child Spec ${i}`)
      return workflow.featureMandate(scope, {
        body,
        ownSpec,
        recordId: `child-mandate-${i}`,
        branch: `feature/${201 + i}-child`,
        parent: workflow.mandateRef(selected),
        inheritedOwnSpecRefs: [
          { uw: parentScope, version: selected.payload.ownSpec.version, sourceAccepted: workflow.mandateRef(selected) },
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
  const parentHistory =
    selectedParent?.history ??
    workflow.historyFrom(
      initialParentPlan === 'framed' ? [parent] : eligiblePlanAt(parent, p0, [parentBasis], undefined, parentPlan),
    )
  const bases = [p0, firstMerge, secondMerge]
  const makeReviews = async (selected: ParentDeliveryWorld['parent'], history: DecodedHistory) => {
    const children = childrenFor(selected)
    const mandateHistories = children.map((mandate) =>
      workflow.historyFrom([mandate], 'operator', 'operator', [history]),
    )
    const context = [history, ...mandateHistories]
    const projection = roxabiRecordFixtures().projection
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
    return reviews
  }
  const reviews = selectParentInWorld ? [] : await makeReviews(parent, parentHistory)
  const histories = selectParentInWorld
    ? [
        parentHistory,
        ...scopes.map((scope) => workflow.historyFrom([workflow.identityAllocation(scope)])),
        ...scopes.map((_, i) => emptyDeliveryHistory({ repository, target: `${repository}#${301 + i}` })),
      ]
    : [parentHistory, ...reviews.flatMap((entry) => [entry.review.issueHistory, entry.review.history])]
  const declared = scopes.map((uw, i) => {
    const head = heads[i]
    const base = bases[i]
    const merge = merges[i]
    if (!head || !base || !merge) throw new Error(`Missing declared delivery ${i}`)
    return {
      uw,
      pullRequest: { repository, target: `${repository}#${301 + i}` },
      branch: `feature/${201 + i}-child`,
      head,
      base,
      merge,
    }
  })
  const parentHead = git.parentHead
  const { commits, comparisons } = parentCommitFacts({
    p0,
    parentHead,
    firstBaseTree,
    git,
    reviews: declared,
    merges: [firstMerge, secondMerge, thirdMerge],
    heads: [firstHead, secondHead, thirdHead],
  })
  const { pullRequests, deliveredEpic, unmanagedEpic } = parentDeliveryInventory(
    repository,
    parentScope,
    scopes,
    graph,
    declared,
    p0,
    merges,
    heads,
    parentHead,
  )
  return withNativeImplementationWorld(
    {
      graph,
      histories,
      commits,
      pullRequests: selectParentInWorld ? [] : pullRequests,
      linkedPullRequests: [{ issue: parentScope, pulls: [] }],
      comparisons,
      epic: selectParentInWorld ? unmanagedEpic : deliveredEpic,
      author: 'operator',
      anchor: parentScope,
      plugin: standaloneReviewInputs().manifest.plugin,
      ...(operator === undefined ? {} : { operator }),
      ...(git.originUrl === undefined ? {} : { originUrl: git.originUrl }),
      ...(git.repositoryFiles === undefined ? {} : { repositoryFiles: git.repositoryFiles }),
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
    (native) =>
      completeDeliveryWorld(
        native,
        {
          git,
          parent,
          selectParentInWorld,
          makeReviews,
          reviews,
          histories,
          repository,
          pullRequests,
          deliveredEpic,
          parentScope,
          p0,
          merges,
          heads,
          parentHead,
        },
        use,
      ),
  )
}
