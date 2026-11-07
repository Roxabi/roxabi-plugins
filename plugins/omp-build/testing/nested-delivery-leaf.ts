import { execFileSync } from 'node:child_process'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { criterionReviewGraph } from './criterion-approval.ts'
import type { nativeImplementationGit } from './native-implementation-git.ts'
import { produceNativeImplementation } from './native-implementation-producer.ts'
import type { withNativeImplementationWorld } from './native-implementation-world.ts'
import type { nestedDeliveryFactsFixture } from './nested-delivery-facts.ts'
import { roxabiRecordFixtures } from './roxabi-presets.ts'

type Scenario = ReturnType<typeof nestedDeliveryFactsFixture>
type Git = ReturnType<typeof nativeImplementationGit>
type World = Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
type LeafArgs = {
  world: World
  git: Git
  parent: Awaited<ReturnType<Git['parent']>>
  scenario: Scenario
  leafHead: string
  leafMerge: string
  post: (scope: Scenario['root'], comments: readonly { body: string }[]) => Promise<void>
}
type Before = Awaited<ReturnType<World['operations']['readUw']>>

function ancestors(before: Before, scenario: Scenario) {
  return [scenario.middle, scenario.root].map((scope) => {
    const history = before.histories.find((entry) => entry.source.scope.target === scope.target)
    if (!history) throw new Error(`Missing native ancestor ${scope.target}`)
    return history
  })
}

function advanceLeaf({ parent, leafHead }: LeafArgs) {
  execFileSync('git', ['-C', parent.cwd, 'merge', '--ff-only', leafHead])
  return { head: leafHead, tree: parent.tree(leafHead) }
}

function implementationPorts({ world }: LeafArgs) {
  return { cwd: world.cwd, gh: world.gh, git: world.git, operations: world.operations }
}

function implementationScope(args: LeafArgs, before: Before, parents: ReturnType<typeof ancestors>) {
  return { read: before, scope: args.scenario.leaf, mandate: args.scenario.leafMandate, parents }
}

async function implementLeaf(args: LeafArgs, before: Before, parents: ReturnType<typeof ancestors>) {
  return produceNativeImplementation({
    ...implementationPorts(args),
    ...implementationScope(args, before, parents),
    startHead: args.git.p0,
    command: 'bun test leaf.test.ts',
    output: 'PASS leaf',
    advance: () => advanceLeaf(args),
  })
}

type Produced = Awaited<ReturnType<typeof implementLeaf>>

type Binding = ReturnType<Scenario['workflow']['workflowBinding']>

function observeLeaf({ scenario, git, leafHead, leafMerge, world }: LeafArgs) {
  world.observePullRequest({
    scope: scenario.pullRequest,
    branch: 'feature/202-leaf',
    base: 'main',
    head: leafHead,
    baseTip: git.p0,
    state: 'MERGED',
    mergeCommit: leafMerge,
    author: 'operator',
  })
}

async function publishLeaf(
  args: LeafArgs,
  binding: Binding,
  produced: Produced,
  parents: ReturnType<typeof ancestors>,
) {
  const { scenario, git, parent, leafMerge, post } = args
  const history = scenario.workflow.historyFrom([binding], 'operator', 'operator', [produced.history, ...parents])
  await post(scenario.pullRequest, history.source.comments)
  git.publishBase(leafMerge)
  parent.checkout(leafMerge)
  observeLeaf(args)
}

async function readPublishedLeaf({ world, scenario }: LeafArgs) {
  const read = await world.operations.readUw(scenario.leaf)
  if (read.observation.status !== 'complete' || read.accepted.status !== 'accepted')
    throw new Error('Leaf observation unavailable')
  const pullHistory = read.histories.find((history) => history.source.scope.target === scenario.pullRequest.target)
  if (!pullHistory) throw new Error('Published binding history unavailable')
  const effective = resolveSpecEffective({
    mode: 'current',
    own: read.accepted.value.ref,
    histories: read.histories,
    graph: read.graph,
  })
  if (!effective.ok)
    throw new Error(`Leaf effective specification unavailable: ${JSON.stringify(effective.diagnostics)}`)
  return { pullHistory, effective }
}
type Published = Awaited<ReturnType<typeof readPublishedLeaf>>

function leafBindingReference(pullRequest: Scenario['pullRequest'], binding: Binding) {
  return {
    source: 'record' as const,
    record: { scope: pullRequest, kind: 'workflow-binding' as const, recordId: binding.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(binding.payload),
  }
}

function leafSubject({ scenario }: LeafArgs, binding: Binding) {
  return {
    kind: 'uw' as const,
    uw: scenario.leaf,
    pullRequest: scenario.pullRequest,
    binding: leafBindingReference(scenario.pullRequest, binding),
  }
}

function leafDeliveryData({ scenario }: LeafArgs, produced: Produced) {
  return [
    {
      source: 'record' as const,
      role: 'implementation' as const,
      record: { scope: scenario.leaf, kind: 'action-receipt' as const, recordId: produced.receipt.recordId },
      selector: '/payload/structured/criteria/0',
      digest: canonicalValueDigest(produced.declaration),
    },
  ]
}

function leafCode({ scenario, git, leafHead }: LeafArgs) {
  return { repository: scenario.leaf.repository, base: git.p0, head: leafHead, referenceCommit: leafHead }
}

function leafInputs(args: LeafArgs, binding: Binding, produced: Produced, published: Published) {
  const seed = acceptedActionInputs(args.scenario.leafMandate, 'review', published.effective.value)
  const manifest = {
    ...seed.manifest,
    subject: leafSubject(args, binding),
    code: leafCode(args),
    deliveryData: leafDeliveryData(args, produced),
  }
  return { ...seed, manifest, fingerprint: actionInputDigest(manifest) }
}
type Inputs = ReturnType<typeof leafInputs>

function leafReviewSubject(args: LeafArgs, produced: Produced, published: Published) {
  return {
    mandate: args.scenario.leafMandate,
    head: args.leafHead,
    issueRecords: recordsOf(produced.history),
    issueHistory: produced.history,
    scope: args.scenario.pullRequest,
    pullHistory: published.pullHistory,
  }
}

function leafReview(args: LeafArgs, prepared: Prepared, published: Published, inputs: Inputs) {
  return criterionReviewGraph({
    ...leafReviewSubject(args, prepared.produced, published),
    inputs,
    projection: roxabiRecordFixtures().projection,
    graph: args.scenario.facts.graph,
    contextHistories: prepared.parents,
    prefix: 'nested-leaf',
    author: 'operator',
  })
}

function implementationStart(produced: Produced) {
  const record = recordsOf(produced.history).find((item) => item.recordId === produced.opened.start.recordId)
  if (record?.kind !== 'action-receipt' || record.payload.action !== 'implement' || record.payload.phase !== 'start')
    throw new Error('Leaf START unavailable')
  return record
}

function leafPlan(before: Before, scenario: Scenario) {
  const history = before.histories.find((entry) => entry.source.scope.target === scenario.leaf.target)
  if (!history) throw new Error('Leaf plan history unavailable')
  return recordsOf(history).filter(
    (record) =>
      record.kind === 'action-receipt' && (record.payload.action === 'plan' || record.payload.action === 'plan-review'),
  )
}

function leafTrace(scenario: Scenario, prepared: Prepared, reviewed: Reviewed) {
  return {
    effective: reviewed.effective.value,
    plan: leafPlan(prepared.before, scenario),
    start: implementationStart(prepared.produced),
    implementation: prepared.produced.receipt,
    reviewInputs: reviewed.inputs,
    review: reviewed.review.review,
  }
}

async function prepareLeaf(args: LeafArgs) {
  const { world, git, parent, scenario } = args
  execFileSync('git', ['-C', parent.cwd, 'switch', '-c', 'feature/202-leaf', git.p0])
  const before = await world.operations.readUw(scenario.leaf)
  const parents = ancestors(before, scenario)
  const produced = await implementLeaf(args, before, parents)
  const binding = scenario.workflow.workflowBinding(
    scenario.pullRequest,
    scenario.leafMandate,
    'feature/202-leaf',
    'main',
  )
  await publishLeaf(args, binding, produced, parents)
  return { before, parents, produced, binding }
}
type Prepared = Awaited<ReturnType<typeof prepareLeaf>>

async function reviewLeaf(args: LeafArgs, prepared: Prepared) {
  const published = await readPublishedLeaf(args)
  const inputs = leafInputs(args, prepared.binding, prepared.produced, published)
  const review = leafReview(args, prepared, published, inputs)
  await args.post(args.scenario.leaf, review.issueComments)
  await args.post(args.scenario.pullRequest, review.comments)
  return { ...published, inputs, review }
}
type Reviewed = Awaited<ReturnType<typeof reviewLeaf>>

function leafReviewContext(scenario: Scenario, prepared: Prepared, reviewed: Reviewed) {
  return {
    inputs: reviewed.inputs,
    review: reviewed.review,
    issueHistory: prepared.produced.history,
    pullHistory: reviewed.pullHistory,
    parents: prepared.parents,
    graph: scenario.facts.graph,
  }
}

function leafProduction({ before, produced, parents }: Prepared) {
  return { before, produced, parents }
}

export async function produceNestedLeaf(args: LeafArgs) {
  const prepared = await prepareLeaf(args)
  const reviewed = await reviewLeaf(args, prepared)
  return {
    ...leafProduction(prepared),
    ...reviewed,
    leafTrace: leafTrace(args.scenario, prepared, reviewed),
    leafReviewContext: leafReviewContext(args.scenario, prepared, reviewed),
  }
}
