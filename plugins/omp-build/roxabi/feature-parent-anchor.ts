import {
  assessTerminalChildParentAdmission,
  canonicalValueDigest,
  isWayfinder,
  projectNativeUwChildren,
  resolveCurrentInheritedOwnSpecRefs,
  sameScope,
  scopeKey,
  selectApplicableMandate,
  unknownWayfinderLabels,
  workflowOperationProblem,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { TerminalChildSuccession } from '../engine/spec-effective-engagement.ts'
import type { UwAdmission } from '../engine/uw-admission.ts'
import type { OwnSpecRef, SpecSnapshot, UwTier } from '../engine/uw-spec-schema.ts'
import type { UwRead } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

/** Resolve the physical Parent checkout anchor from one complete authenticated ancestry cut. */
export async function resolveParentWorktreeAnchor(input: {
  subject: Scope
  read: UwRead
}): Promise<{ ok: true; anchor: Scope } | { ok: false; reason: string }> {
  return walkAncestry(input)
}

/** The exact terminal subject may be checked historically; every other engagement stays active. */
export async function resolveSuccessorWorktreeAnchor(input: {
  subject: Scope
  read: UwRead
  succession: TerminalChildSuccession
}): Promise<{ ok: true; anchor: Scope } | { ok: false; reason: string }> {
  if (!sameScope(input.subject, input.succession.child) || !sameScope(input.subject, input.succession.tip.scope))
    return { ok: false, reason: 'parent-anchor-successor-mismatch' }
  return walkAncestry(input, undefined, input.succession)
}

/** Check planned first-child facts against the same authenticated ancestry walk. */
export async function checkPlannedAncestry(input: {
  subject: Scope
  read: UwRead
  planned: { spec: SpecSnapshot['spec']; tier: UwTier }
}): Promise<{ ok: true; inherited: readonly OwnSpecRef[] } | { ok: false; reason: string }> {
  if (!hasCompleteSubjectObservation(input.subject, input.read))
    return { ok: false, reason: 'parent-anchor-observation-incomplete' }
  const inherited = resolveCurrentInheritedOwnSpecRefs(
    input.subject,
    input.read.observation.graph,
    input.read.observation.histories,
  )
  if (!inherited.ok) return { ok: false, reason: 'current-inheritance-unavailable' }
  const result = await walkAncestry(input, { ...input.planned, inherited: inherited.value })
  return result.ok ? { ok: true, inherited: inherited.value } : result
}

async function walkAncestry(
  input: { subject: Scope; read: UwRead },
  planned?: { spec: SpecSnapshot['spec']; tier: UwTier; inherited: readonly OwnSpecRef[] },
  succession?: TerminalChildSuccession,
): Promise<{ ok: true; anchor: Scope } | { ok: false; reason: string }> {
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
    const problem = await ancestorStepProblem(input.read, ancestor, node.parent, current, planned, succession)
    if (problem !== null) return { ok: false, reason: problem }
    planned = undefined
    succession = undefined
    current = ancestor
  }
}

async function ancestorStepProblem(
  read: UwRead & { observation: Extract<UwRead['observation'], { status: 'complete' }> },
  ancestor: UwRead,
  parent: Scope,
  current: UwRead,
  planned?: { spec: SpecSnapshot['spec']; tier: UwTier; inherited: readonly OwnSpecRef[] },
  succession?: TerminalChildSuccession,
): Promise<string | null> {
  const admission = succession === undefined ? ancestor.admission : terminalChildParentAdmission(ancestor, succession)
  if (!isConfirmedAncestor(ancestor, parent, read.observation, admission)) return 'parent-anchor-ancestor-unconfirmed'
  if (!hasConfirmedChild(ancestor, current)) return 'parent-anchor-ancestry-invalid'
  return confirmAncestorCommitment(read.observation, ancestor, ancestor.accepted, current, planned)
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
  admission: UwAdmission | null,
): ancestor is UwRead & {
  graph: Extract<UwRead['graph'], { status: 'complete' }>
  accepted: Extract<UwRead['accepted'], { status: 'accepted' }>
} {
  return (
    sameScope(ancestor.uw, parent) &&
    ancestor.observation === observation &&
    ancestor.graph.status === 'complete' &&
    ancestor.accepted.status === 'accepted' &&
    admission?.deliverable.ok === true
  )
}

async function confirmAncestorCommitment(
  observation: Extract<UwRead['observation'], { status: 'complete' }>,
  ancestor: UwRead,
  accepted: Extract<UwRead['accepted'], { status: 'accepted' }>,
  current: UwRead,
  planned?: { spec: SpecSnapshot['spec']; tier: UwTier; inherited: readonly OwnSpecRef[] },
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
  const facts = planned === undefined ? await readCurrentFramingFacts({ uw: current.uw, read: current }) : null
  if (facts !== null && !facts.ok) return 'parent-anchor-child-unconfirmed'
  const child =
    planned ??
    (facts?.ok
      ? {
          spec: facts.value.currentSpec.snapshot.spec,
          tier: facts.value.currentSpec.tier,
          inherited: facts.value.currentSpec.inheritedOwnSpecRefs,
        }
      : null)
  if (child === null) return 'parent-anchor-child-unconfirmed'
  const commitments = accepted.value.children.filter((child) => sameScope(child.scope, current.uw))
  const commitment = commitments[0]
  if (
    commitments.length !== 1 ||
    !commitment ||
    commitment.tier !== child.tier ||
    commitment.specVersion !== child.spec.version ||
    canonicalValueDigest(commitment.snapshot.spec) !== canonicalValueDigest(child.spec) ||
    canonicalValueDigest(child.inherited) !==
      canonicalValueDigest([accepted.value.ref, ...accepted.value.inheritedOwnSpecRefs])
  )
    return 'parent-anchor-commitment-mismatch'
  return null
}

function terminalChildParentAdmission(ancestor: UwRead, succession: TerminalChildSuccession): UwAdmission | null {
  if (!ancestor.identity.ok) return null
  return assessTerminalChildParentAdmission(
    {
      uw: ancestor.uw,
      graph: ancestor.graph,
      proposed: ancestor.proposed,
      accepted: ancestor.accepted,
      identities: ancestor.identity.value,
      histories: ancestor.histories,
      catalogues: ancestor.catalogues,
      completion: ancestor.completion,
      phase: 'initial-selection',
    },
    succession,
  )
}
