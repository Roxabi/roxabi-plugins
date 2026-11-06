import {
  canonicalValueDigest,
  isWayfinder,
  projectNativeUwChildren,
  sameScope,
  scopeKey,
  selectApplicableMandate,
  unknownWayfinderLabels,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwRead } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

/** Resolve the physical Parent checkout anchor from one complete authenticated ancestry cut. */
export async function resolveParentWorktreeAnchor(input: {
  subject: Scope
  read: UwRead
}): Promise<{ ok: true; anchor: Scope } | { ok: false; reason: string }> {
  if (!hasCompleteSubjectObservation(input.subject, input.read))
    return { ok: false, reason: 'parent-anchor-observation-incomplete' }
  const nodes = new Map(input.read.graph.nodes.map((node) => [scopeKey(node.uw), node]))
  const visited = new Set<string>()
  let current: UwRead = input.read
  for (;;) {
    const resolved = resolveAncestryNode(current.uw, nodes, visited)
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const node = resolved.node
    if (node.parent === null) return { ok: true, anchor: node.uw }
    if (node.parent.repository !== input.subject.repository || input.read.observedReader === undefined)
      return { ok: false, reason: 'parent-anchor-ancestry-incomplete' }
    const ancestor = await input.read.observedReader.readUw(node.parent)
    if (!isConfirmedAncestor(ancestor, node.parent, input.read.observation))
      return { ok: false, reason: 'parent-anchor-ancestor-unconfirmed' }
    if (!hasConfirmedChild(ancestor, current)) return { ok: false, reason: 'parent-anchor-ancestry-invalid' }
    const problem = await confirmAncestorCommitment(input.read.observation, ancestor, ancestor.accepted, current)
    if (problem !== null) return { ok: false, reason: problem }
    current = ancestor
  }
}

function hasCompleteSubjectObservation(
  subject: Scope,
  read: UwRead,
): read is UwRead & { observation: Extract<UwRead['observation'], { status: 'complete' }> } {
  return sameScope(subject, read.uw) && read.graph.status === 'complete' && read.observation.status === 'complete'
}

function hasConfirmedChild(ancestor: UwRead, current: UwRead): boolean {
  const children = projectNativeUwChildren({ uw: ancestor.uw, graph: ancestor.graph, accepted: ancestor.accepted })
  return children.ok && children.value.some((child) => sameScope(child.uw, current.uw))
}

function resolveAncestryNode(
  uw: Scope,
  nodes: Map<string, UwRead['graph']['nodes'][number]>,
  visited: Set<string>,
): { node: UwRead['graph']['nodes'][number] } | { reason: string } {
  const key = scopeKey(uw)
  if (visited.has(key)) return { reason: 'parent-anchor-cycle' }
  visited.add(key)
  const node = nodes.get(key)
  if (!node || isWayfinder(node) || unknownWayfinderLabels(node).length !== 0)
    return { reason: 'parent-anchor-ancestry-invalid' }
  return { node }
}

function isConfirmedAncestor(
  ancestor: UwRead,
  parent: Scope,
  observation: UwRead['observation'],
): ancestor is UwRead & {
  graph: Extract<UwRead['graph'], { status: 'complete' }>
  accepted: Extract<UwRead['accepted'], { status: 'accepted' }>
} {
  return (
    sameScope(ancestor.uw, parent) &&
    ancestor.observation === observation &&
    ancestor.graph.status === 'complete' &&
    ancestor.accepted.status === 'accepted' &&
    ancestor.admission.deliverable.ok
  )
}

async function confirmAncestorCommitment(
  observation: Extract<UwRead['observation'], { status: 'complete' }>,
  ancestor: UwRead,
  accepted: Extract<UwRead['accepted'], { status: 'accepted' }>,
  current: UwRead,
): Promise<string | null> {
  const histories = observation.histories
  const parentHistories = histories.filter((history) => sameScope(history.source.scope, ancestor.uw))
  const history = parentHistories[0]
  if (parentHistories.length !== 1 || !history || workflowOperationProblem(history) !== null)
    return 'parent-anchor-history-unconfirmed'
  const selected = selectApplicableMandate(
    history,
    histories.filter((entry) => entry !== history),
    { histories, catalogues: observation.catalogues, observation },
  )
  const source = accepted.value.chain[0]?.source
  if (
    selected.status !== 'applicable' ||
    !selected.mandate.payload.permissions.landing ||
    !selected.mandate.payload.permissions.correct ||
    source?.kind !== 'mandate' ||
    source.recordId !== selected.mandate.recordId ||
    !sameScope(source.scope, ancestor.uw)
  )
    return 'parent-anchor-mandate-unconfirmed'
  const facts = await readCurrentFramingFacts({ uw: current.uw, read: current })
  if (!facts.ok) return 'parent-anchor-child-unconfirmed'
  const commitments = accepted.value.children.filter((child) => sameScope(child.scope, current.uw))
  const commitment = commitments[0]
  if (
    commitments.length !== 1 ||
    !commitment ||
    commitment.tier !== facts.value.currentSpec.tier ||
    commitment.specVersion !== facts.value.currentSpec.snapshot.spec.version ||
    canonicalValueDigest(commitment.snapshot) !== canonicalValueDigest(facts.value.currentSpec.snapshot) ||
    canonicalValueDigest(facts.value.currentSpec.inheritedOwnSpecRefs) !==
      canonicalValueDigest([accepted.value.ref, ...accepted.value.inheritedOwnSpecRefs])
  )
    return 'parent-anchor-commitment-mismatch'
  return null
}
