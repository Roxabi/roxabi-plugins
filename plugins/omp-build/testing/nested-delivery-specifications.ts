import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

type Workflow = ReturnType<typeof roxabiWorkflowFixtures>
type Scope = { repository: string; target: string }
type Scopes = { root: Scope; middle: Scope; leaf: Scope }
const date = '2026-10-27T12:00:00Z'

function specificationContent(invariant: string | null, exclusion: string | null) {
  return canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Deliver the assigned work' }],
    invariants: invariant === null ? [] : [{ id: 'I1', statement: invariant }],
    exclusions: exclusion === null ? [] : [exclusion],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
}

function specification(workflow: Workflow, scope: Scope, invariant: string | null, exclusion: string | null) {
  const content = specificationContent(invariant, exclusion)
  if (!content.ok) throw new Error('Invalid nested fixture specification')
  const body = renderIssueSpecBody(content.value, { complexity: 1 })
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, date) })
  if (parsed.status !== 'conformant') throw new Error(`Invalid native issue ${scope.target}`)
  return workflow.ownSpecFromSnapshot(scope, parsed.snapshot)
}

type Specification = ReturnType<typeof specification>
type Specifications = { rootSpec: Specification; middleSpec: Specification; leafSpec: Specification }

function fixtureSpecifications(workflow: Workflow, scopes: Scopes): Specifications {
  return {
    rootSpec: specification(workflow, scopes.root, 'Keep the root invariant', 'Exclude root migration'),
    middleSpec: specification(workflow, scopes.middle, 'Keep the middle invariant', 'Exclude middle migration'),
    leafSpec: specification(workflow, scopes.leaf, null, null),
  }
}

function childSpec(scope: Scope, spec: Specification) {
  return { scope, snapshot: spec.snapshot, specVersion: spec.version, tier: 'S' as const }
}

function rootMandateFor(workflow: Workflow, scopes: Scopes, specs: Specifications) {
  const { rootSpec, middleSpec } = specs
  const options = { recordId: 'nested-root-mandate', body: rootSpec.snapshot.raw.body, ownSpec: rootSpec }
  const seed = workflow.epicMandate(scopes.root, [childSpec(scopes.middle, middleSpec)], options)
  const built = buildRecord({ ...seed, payload: { ...seed.payload, branch: null } })
  if (!built.ok || built.value.kind !== 'mandate') throw new Error('Invalid root mandate')
  return built.value
}

type Mandate = ReturnType<typeof rootMandateFor>

function acceptedRef(workflow: Workflow, scope: Scope, spec: Specification, mandate: Mandate) {
  return { uw: scope, version: spec.version, sourceAccepted: workflow.mandateRef(mandate) }
}

type AcceptedRef = ReturnType<typeof acceptedRef>

function middleOptions(spec: Specification, rootRef: AcceptedRef) {
  return {
    recordId: 'nested-middle-mandate',
    body: spec.snapshot.raw.body,
    ownSpec: spec,
    inheritedOwnSpecRefs: [rootRef],
  }
}

function middleMandateFor(
  workflow: Workflow,
  scopes: Scopes,
  specs: Specifications,
  root: Mandate,
  rootRef: AcceptedRef,
) {
  const options = middleOptions(specs.middleSpec, rootRef)
  const seed = workflow.epicMandate(scopes.middle, [childSpec(scopes.leaf, specs.leafSpec)], options)
  const payload = { ...seed.payload, parent: workflow.mandateRef(root), branch: null }
  const built = buildRecord({ ...seed, payload })
  if (!built.ok || built.value.kind !== 'mandate') throw new Error('Invalid middle mandate')
  return built.value
}

function leafOptions(workflow: Workflow, specs: Specifications, middle: Mandate, refs: AcceptedRef[]) {
  return {
    recordId: 'nested-leaf-mandate',
    body: specs.leafSpec.snapshot.raw.body,
    ownSpec: specs.leafSpec,
    branch: 'feature/202-leaf',
    parent: workflow.mandateRef(middle),
    inheritedOwnSpecRefs: refs,
  }
}

function leafMandateFor(
  workflow: Workflow,
  scopes: Scopes,
  specs: Specifications,
  middle: Mandate,
  refs: AcceptedRef[],
) {
  return workflow.featureMandate(scopes.leaf, leafOptions(workflow, specs, middle, refs))
}

function graphNodeDetails(uw: Scope, own: Specification) {
  return {
    uw,
    title: uw.target,
    raw: own.snapshot.raw,
    updatedAt: date,
    labels: ['size:S'],
    wayfinderLabels: [],
  }
}

function graphNode(uw: Scope, own: Specification, parent: Scope | null, children: Scope[]) {
  return {
    ...graphNodeDetails(uw, own),
    parent,
    children,
    blockers: [],
    native: { state: 'OPEN' as const, stateReason: null },
  }
}

function graphFor(scopes: Scopes, specs: Specifications): Extract<UwGraphObservation, { status: 'complete' }> {
  return {
    status: 'complete',
    root: scopes.root,
    observedAt: date,
    nodes: [
      graphNode(scopes.root, specs.rootSpec, null, [scopes.middle]),
      graphNode(scopes.middle, specs.middleSpec, scopes.root, [scopes.leaf]),
      graphNode(scopes.leaf, specs.leafSpec, scopes.middle, []),
    ],
  }
}

function fixtureData(workflow: Workflow, scopes: Scopes) {
  const specs = fixtureSpecifications(workflow, scopes)
  const rootMandate = rootMandateFor(workflow, scopes, specs)
  const rootRef = acceptedRef(workflow, scopes.root, specs.rootSpec, rootMandate)
  const middleMandate = middleMandateFor(workflow, scopes, specs, rootMandate, rootRef)
  const middleRef = acceptedRef(workflow, scopes.middle, specs.middleSpec, middleMandate)
  const leafMandate = leafMandateFor(workflow, scopes, specs, middleMandate, [middleRef, rootRef])
  const graph = graphFor(scopes, specs)
  return { graph, rootMandate, middleMandate, leafMandate }
}

function fixtureResult(workflow: Workflow, scopes: Scopes, data: ReturnType<typeof fixtureData>) {
  const { root, middle, leaf } = scopes
  const { graph, rootMandate, middleMandate, leafMandate } = data
  return { workflow, graph, root, middle, leaf, rootMandate, middleMandate, leafMandate }
}

/** Native issue bodies and reciprocal links are declared independently of the delivery receipts. */
export function nestedDeliverySpecificationsFixture() {
  const repository = 'acme/app'
  const root = { repository, target: `${repository}#200` }
  const middle = { repository, target: `${repository}#203` }
  const leaf = { repository, target: `${repository}#202` }
  const workflow = roxabiWorkflowFixtures()
  const scopes = { root, middle, leaf }
  return fixtureResult(workflow, scopes, fixtureData(workflow, scopes))
}
