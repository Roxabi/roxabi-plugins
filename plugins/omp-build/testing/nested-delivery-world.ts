import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { NativeEpicPullRequest } from '../adapters/github-native/epic-children.ts'
import type { Scope } from '../engine/record-values.ts'
import { standaloneReviewInputs } from './action-input-fixtures.ts'
import { nativeImplementationGit } from './native-implementation-git.ts'
import { withNativeImplementationWorld } from './native-implementation-world.ts'
import { nestedDeliveryFactsFixture } from './nested-delivery-facts.ts'
import { type IntegrationContext, integrateNestedDelivery } from './nested-delivery-integration.ts'
import { produceNestedLeaf } from './nested-delivery-leaf.ts'
import { nestedDeliverySpecificationsFixture } from './nested-delivery-specifications.ts'

/** Native issue bodies and reciprocal links are declared independently of the delivery receipts. */
export function nestedDeliverySpecifications() {
  return nestedDeliverySpecificationsFixture()
}

/** Only facts obtained from the isolated Git fixture and independently declared native issues. */
export function nestedDeliveryFacts(git: Parameters<typeof nestedDeliveryFactsFixture>[0]) {
  return nestedDeliveryFactsFixture(git)
}

type Git = ReturnType<typeof nativeImplementationGit>
type Parent = Awaited<ReturnType<Git['parent']>>
type World = Parameters<Parameters<typeof withNativeImplementationWorld>[1]>[0]
type Scenario = ReturnType<typeof nestedDeliveryFactsFixture>
type ScenarioName = 'complete' | 'middle-missing-coverage'
type NestedDeliveryContinuation = (context: {
  world: World
  git: Git
  target: Parameters<typeof integrateNestedDelivery>[1]
  proof: Awaited<ReturnType<typeof integrateNestedDelivery>>
}) => Promise<void>
type NestedDeliveryMidpoint = (context: {
  world: World
  git: Git
  root: Scenario['root']
  middle: Scenario['middle']
  rootMandate: Scenario['rootMandate']
  middleMandate: Scenario['middleMandate']
  proof: Awaited<ReturnType<typeof integrateNestedDelivery>>
}) => Promise<void>
type Context = {
  git: Git
  parent: Parent
  scenario: Scenario
  scenarioName: ScenarioName
  leafHead: string
  leafMerge: string
  use: NestedDeliveryContinuation | undefined
  midpoint: NestedDeliveryMidpoint | undefined
}

function checkout(branch: string | null, head: string, baseTip: string) {
  return { branch, head, base: 'main', baseTip, remoteTip: head }
}

function repositoryFiles(context: Context) {
  const { git, scenario, leafMerge } = context
  const bytes = execFileSync('git', ['-C', git.cwd, 'show', `${leafMerge}:fixture.txt`])
  const ref = {
    source: 'git-file' as const,
    repository: scenario.root.repository,
    commit: leafMerge,
    path: 'fixture.txt',
    digest: createHash('sha256').update(bytes).digest('hex'),
  }
  return [{ ref, bytes }]
}

function postComments(world: World) {
  return async (scope: Scope, comments: readonly { body: string }[]) => {
    const number = scope.target.split('#')[1]
    for (const comment of comments)
      await world.gh(world.cwd, [
        'api',
        '--method',
        'POST',
        `repos/acme/app/issues/${number}/comments`,
        '-f',
        `body=${comment.body}`,
      ])
  }
}

function integrateMiddle(context: Context, integration: IntegrationContext) {
  const { scenario, leafMerge } = context
  return integrateNestedDelivery(
    integration,
    scenario.middle,
    scenario.middleMandate,
    scenario.leaf,
    leafMerge,
    leafMerge,
  )
}

function integrateRoot(context: Context, integration: IntegrationContext) {
  const { scenario, leafMerge } = context
  return integrateNestedDelivery(
    integration,
    scenario.root,
    scenario.rootMandate,
    scenario.middle,
    leafMerge,
    leafMerge,
  )
}

async function runMiddle(context: Context, world: World, post: ReturnType<typeof postComments>) {
  const { scenario, parent, scenarioName } = context
  const leaf = await produceNestedLeaf({ ...context, world, post })
  const initial = await world.operations.readUw(scenario.root)
  const integration = { world, git: parent, scenarioName, middle: scenario.middle, post, checkout }
  const proof = await integrateMiddle(context, integration)
  const middle = await world.operations.readUw(scenario.root)
  return { leaf, initial, integration, proof, middle }
}

type Middle = Awaited<ReturnType<typeof runMiddle>>
type UwRead = Awaited<ReturnType<World['operations']['readUw']>>
type CompleteRead = {
  observation: Extract<UwRead['observation'], { status: 'complete' }>
  completion: UwRead['completion']
}

function commonIdentity(context: Context) {
  const { scenario } = context
  const { root, leaf, rootMandate, middleMandate, leafMandate } = scenario
  return {
    mode: context.scenarioName,
    root,
    middleScope: scenario.middle,
    leaf,
    rootMandate,
    middleMandate,
    leafMandate,
  }
}

function commonResult(context: Context, middle: Middle) {
  return {
    ...commonIdentity(context),
    initial: middle.initial.completion,
    middle: middle.middle.completion,
    middleProof: middle.proof,
    leafTrace: middle.leaf.leafTrace,
    leafReviewContext: middle.leaf.leafReviewContext,
  }
}

function rootResult(context: Context, middle: Middle, final: CompleteRead, proof: Middle['proof']) {
  return {
    ...commonResult(context, middle),
    final: { observation: final.observation, completion: final.completion },
    rootProof: proof,
  }
}

async function finishRoot(context: Context, world: World, middle: Middle) {
  const { scenario, git, use } = context
  const proof = await integrateRoot(context, middle.integration)
  const final = await world.operations.readUw(scenario.root)
  if (final.observation.status !== 'complete') throw new Error('Final native observation incomplete')
  await use?.({ world, git, target: scenario.root, proof })
  return rootResult(context, middle, { observation: final.observation, completion: final.completion }, proof)
}

function midpointInput(context: Context, world: World, middle: Middle) {
  const { root, middle: middleScope, rootMandate, middleMandate } = context.scenario
  return { world, git: context.git, root, middle: middleScope, rootMandate, middleMandate, proof: middle.proof }
}

async function runMidpoint(context: Context, world: World, middle: Middle, midpoint: NestedDeliveryMidpoint) {
  await midpoint(midpointInput(context, world, middle))
  return { ...commonResult(context, middle), final: null, rootProof: null }
}

async function runInWorld(context: Context, shared: World) {
  const world = await shared.at(context.parent.cwd)
  const middle = await runMiddle(context, world, postComments(world))
  if (context.midpoint) return runMidpoint(context, world, middle, context.midpoint)
  if (context.scenarioName !== 'middle-missing-coverage') return finishRoot(context, world, middle)
  await context.use?.({ world, git: context.git, target: context.scenario.middle, proof: middle.proof })
  return { ...commonResult(context, middle), final: null, rootProof: null }
}

function leafDiff(context: Context) {
  const { git, leafHead } = context
  return { base: git.p0, head: leafHead, bytes: git.diff(git.p0, leafHead) }
}

function leafPullMetadata(context: Context) {
  return {
    mergedAt: '2026-10-27T12:10:00Z',
    mergeCommit: { oid: context.leafMerge, parents: { nodes: [{ oid: context.git.p0 }] } },
    autoMergeRequest: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    repository: { nameWithOwner: context.scenario.root.repository },
    isCrossRepository: false,
  }
}

function leafEpicPull(context: Context): NativeEpicPullRequest {
  return {
    number: 302,
    state: 'MERGED',
    baseRefName: 'main',
    headRefName: 'feature/202-leaf',
    headRefOid: context.leafHead,
    ...leafPullMetadata(context),
  }
}

function fixtureCheck(context: Context) {
  return {
    sha: context.leafMerge,
    nodes: [{ __typename: 'StatusContext' as const, context: 'fixture-ci', state: 'SUCCESS' }],
  }
}

function epicSeed(context: Context) {
  const { leaf, middle } = context.scenario
  return {
    children: [
      { scope: leaf, closedBy: [leafEpicPull(context)], timeline: [] },
      { scope: middle, closedBy: [], timeline: [] },
    ],
    checks: [fixtureCheck(context)],
  }
}

function worldSeed(context: Context) {
  const { git, parent, scenario } = context
  return {
    ...scenario.facts,
    anchor: scenario.leaf,
    repositoryFiles: repositoryFiles(context),
    originUrl: git.originUrl,
    cwd: parent.cwd,
    plugin: standaloneReviewInputs().manifest.plugin,
    checkout: checkout('feature/202-leaf', git.p0, git.p0),
    epic: epicSeed(context),
    diffs: [leafDiff(context)],
  }
}

async function runScenario(context: Context) {
  return withNativeImplementationWorld(worldSeed(context), (world) => runInWorld(context, world))
}

async function createContext(
  git: Git,
  scenarioName: ScenarioName,
  use: NestedDeliveryContinuation | undefined,
  midpoint: NestedDeliveryMidpoint | undefined,
): Promise<Context> {
  const scenario = nestedDeliveryFacts(git)
  const [leafHead] = git.heads
  const [leafMerge] = git.merges
  if (leafHead === undefined || leafMerge === undefined)
    throw new Error('Nested scenario requires a declared child head and merge')
  const parent = await git.parent(scenario.root)
  return { git, parent, scenario, scenarioName, leafHead, leafMerge, use, midpoint }
}

export async function runNestedDeliveryScenario(
  scenarioName: ScenarioName,
  use?: NestedDeliveryContinuation,
  midpoint?: NestedDeliveryMidpoint,
) {
  const git = nativeImplementationGit(202)
  try {
    return await runScenario(await createContext(git, scenarioName, use, midpoint))
  } finally {
    git.cleanup()
  }
}
