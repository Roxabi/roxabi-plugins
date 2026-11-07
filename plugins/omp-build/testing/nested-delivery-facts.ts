import { actionInputDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { resolveSpecEffective } from '../engine/spec-effective.ts'
import type { SpecEffective } from '../engine/spec-effective-schema.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'
import { nestedDeliverySpecificationsFixture } from './nested-delivery-specifications.ts'
import { blank, eligiblePlan } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

type Scenario = ReturnType<typeof nestedDeliverySpecificationsFixture>
type Workflow = Scenario['workflow']
type FixtureGit = {
  p0: string
  heads: readonly string[]
  merges: readonly string[]
  parentHead: string
  tree(sha: string): string
}
type CommitSpec = { sha: string; parents: string[]; subject: string }
type PlanRecord = ReturnType<typeof eligiblePlan>[number]

function bindPlanRecord(record: PlanRecord, mandate: MandateRecord, commit: string) {
  if (record.kind !== 'action-receipt') return record
  const previous = record.payload.inputs
  const manifest = {
    ...previous.manifest,
    code: { repository: mandate.repository, base: commit, head: commit, referenceCommit: commit },
  }
  const built = buildRecord({
    ...record,
    payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
  })
  if (!built.ok) throw new Error(`Cannot bind plan: ${JSON.stringify(built.diagnostics)}`)
  return built.value
}

/** Bind fixture plan receipts to the independently declared checkout. */
function planAt(
  mandate: MandateRecord,
  commit: string,
  histories: readonly DecodedHistory[],
  effective: SpecEffective,
) {
  return eligiblePlan(mandate, histories, effective).map((record) => bindPlanRecord(record, mandate, commit))
}

function fixtureIdentity(workflow: Workflow, mandate: MandateRecord) {
  const seed = workflow.identityAllocation(mandate.payload.ownSpec.uw)
  if (seed.kind !== 'spec-identity' || seed.payload.event !== 'allocate')
    throw new Error('Expected identity allocation fixture')
  const spec = mandate.payload.ownSpec.snapshot.spec
  const allocations = [
    ...spec.criteria.map((item) => ({ draftKey: `criterion-${item.id}`, id: item.id })),
    ...spec.invariants.map((item) => ({ draftKey: `invariant-${item.id}`, id: item.id })),
  ]
  const result = buildRecord({ ...seed, payload: { ...seed.payload, allocations } })
  if (!result.ok || result.value.kind !== 'spec-identity') throw new Error('Invalid nested specification identities')
  return result.value
}

function fixtureEffective(mandate: MandateRecord, histories: DecodedHistory[], graph: Scenario['graph']) {
  const accepted = resolveAcceptedSpec(mandate, histories)
  if (!accepted.ok) throw new Error('Nested accepted specification unavailable')
  const resolved = resolveSpecEffective({ mode: 'current', own: accepted.spec.ref, histories, graph })
  if (!resolved.ok)
    throw new Error(`Nested effective specification unavailable: ${JSON.stringify(resolved.diagnostics)}`)
  return resolved.value
}

function fixtureIdentities(scenario: Scenario) {
  const { workflow, rootMandate, middleMandate, leafMandate } = scenario
  const root = fixtureIdentity(workflow, rootMandate)
  const middle = fixtureIdentity(workflow, middleMandate)
  const leaf = fixtureIdentity(workflow, leafMandate)
  return { root, middle, leaf }
}

function fixtureHistories(scenario: Scenario) {
  const { workflow, rootMandate, middleMandate, leafMandate } = scenario
  const identities = fixtureIdentities(scenario)
  const root = workflow.historyFrom([identities.root, rootMandate])
  const middle = workflow.historyFrom([identities.middle, middleMandate], 'operator', 'operator', [root])
  const leaf = workflow.historyFrom([identities.leaf, leafMandate], 'operator', 'operator', [middle, root])
  return { identities, root, middle, leaf, histories: [root, middle, leaf] }
}

type HistoryContext = ReturnType<typeof fixtureHistories>
type PlanInput = {
  mandate: MandateRecord
  identity: HistoryContext['identities']['root']
  commit: string
  parents: DecodedHistory[]
}

function plannedHistory(scenario: Scenario, context: HistoryContext, input: PlanInput) {
  const effective = fixtureEffective(input.mandate, context.histories, scenario.graph)
  const records = [input.identity, ...planAt(input.mandate, input.commit, context.histories, effective)]
  return scenario.workflow.historyFrom(records, 'operator', 'operator', input.parents)
}

function rootPlanFor(scenario: Scenario, context: HistoryContext, commit: string) {
  return plannedHistory(scenario, context, {
    mandate: scenario.rootMandate,
    identity: context.identities.root,
    commit,
    parents: [context.middle, context.leaf],
  })
}

function middlePlanFor(scenario: Scenario, context: HistoryContext, commit: string, root: DecodedHistory) {
  return plannedHistory(scenario, context, {
    mandate: scenario.middleMandate,
    identity: context.identities.middle,
    commit,
    parents: [root, context.leaf],
  })
}

function leafPlanFor(scenario: Scenario, context: HistoryContext, commit: string, parents: DecodedHistory[]) {
  return plannedHistory(scenario, context, {
    mandate: scenario.leafMandate,
    identity: context.identities.leaf,
    commit,
    parents,
  })
}

function fixturePlans(scenario: Scenario, p0: string, merge0: string) {
  const context = fixtureHistories(scenario)
  const rootPlan = rootPlanFor(scenario, context, merge0)
  const middlePlan = middlePlanFor(scenario, context, merge0, rootPlan)
  const leafPlan = leafPlanFor(scenario, context, p0, [middlePlan, rootPlan])
  return [rootPlan, middlePlan, leafPlan]
}

function declaredCommits(git: FixtureGit) {
  const [head0, head1, head2] = git.heads
  const [merge0, merge1, merge2] = git.merges
  if (
    head0 === undefined ||
    head1 === undefined ||
    head2 === undefined ||
    merge0 === undefined ||
    merge1 === undefined ||
    merge2 === undefined
  )
    throw new Error('Nested fixture requires three declared child heads and merges')
  return { head0, head1, head2, merge0, merge1, merge2 }
}

type DeclaredCommits = ReturnType<typeof declaredCommits>
function fixtureSpecs(git: FixtureGit, declared: DeclaredCommits): CommitSpec[] {
  const { head0, head1, head2, merge0, merge1, merge2 } = declared
  return [
    { sha: git.p0, parents: [], subject: 'fixture base' },
    { sha: head0, parents: [git.p0], subject: 'feat: implement fixture (#202)' },
    { sha: merge0, parents: [git.p0, head0], subject: 'merge child 1' },
    { sha: head1, parents: [merge0], subject: 'feat: implement fixture (#203)' },
    { sha: merge1, parents: [merge0, head1], subject: 'merge child 2' },
    { sha: head2, parents: [merge1], subject: 'feat: implement fixture (#204)' },
    { sha: merge2, parents: [merge1, head2], subject: 'merge child 3' },
    { sha: git.parentHead, parents: [merge2], subject: 'feat: integrate children (#200)' },
  ]
}

function reachable(bySha: Map<string, CommitSpec>, sha: string) {
  const found = new Set<string>()
  const pending = [sha]
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (found.has(current)) continue
    const item = bySha.get(current)
    if (!item) throw new Error(`Undeclared fixture commit ${current}`)
    found.add(current)
    pending.push(...item.parents)
  }
  return found
}

function comparison(specs: CommitSpec[], bySha: Map<string, CommitSpec>, base: CommitSpec, head: CommitSpec) {
  const after = reachable(bySha, head.sha)
  if (!after.has(base.sha)) return null
  const before = reachable(bySha, base.sha)
  const commits = specs.filter((item) => after.has(item.sha) && !before.has(item.sha)).map((item) => item.sha)
  return {
    base: base.sha,
    head: head.sha,
    status: commits.length ? ('ahead' as const) : ('identical' as const),
    commits,
  }
}

function fixtureComparisons(specs: CommitSpec[]) {
  const bySha = new Map(specs.map((item) => [item.sha, item]))
  const comparisons: NativeWorldFacts['comparisons'][number][] = []
  for (const base of specs)
    for (const head of specs) {
      const result = comparison(specs, bySha, base, head)
      if (result) comparisons.push(result)
    }
  return comparisons
}

function fixtureFacts(scenario: Scenario, histories: DecodedHistory[], git: FixtureGit, declared: DeclaredCommits) {
  const pullRequest = { repository: scenario.root.repository, target: `${scenario.root.repository}#302` }
  const specs = fixtureSpecs(git, declared)
  const commits = specs.map((item) => ({ ...item, tree: git.tree(item.sha), paths: ['fixture.txt'], config: null }))
  const comparisons = fixtureComparisons(specs)
  return { facts: assembleFacts({ scenario, histories, pullRequest, commits, comparisons }), pullRequest }
}

type FactParts = {
  scenario: Scenario
  histories: DecodedHistory[]
  pullRequest: { repository: string; target: string }
  commits: NativeWorldFacts['commits']
  comparisons: NativeWorldFacts['comparisons']
}

function assembleFacts({ scenario, histories, pullRequest, commits, comparisons }: FactParts): NativeWorldFacts {
  return {
    graph: scenario.graph,
    histories: [...histories, blank(pullRequest)],
    commits,
    comparisons,
    pullRequests: [],
    author: 'operator',
  }
}

/** Only facts obtained from the isolated Git fixture and independently declared native issues. */
export function nestedDeliveryFactsFixture(git: FixtureGit) {
  const scenario = nestedDeliverySpecificationsFixture()
  const declared = declaredCommits(git)
  const histories = fixturePlans(scenario, git.p0, declared.merge0)
  return { ...scenario, ...fixtureFacts(scenario, histories, git, declared) }
}
