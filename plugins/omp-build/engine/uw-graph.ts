import type { Scope } from './record-values.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import type { SpecRawSource } from './uw-spec.ts'
export const WAYFINDER_LABELS = [
  'wayfinder:prototype',
  'wayfinder:task',
  'wayfinder:research',
  'wayfinder:grilling',
  'wayfinder:map',
] as const
export type UwNativeNode = {
  uw: Scope
  title: string
  raw: SpecRawSource
  updatedAt: string
  labels: readonly string[]
  wayfinderLabels: readonly string[]
  parent: Scope | null
  children: readonly Scope[]
  blockers: readonly Scope[]
  native: { state: 'OPEN' | 'CLOSED'; stateReason: string | null }
}
export type UwGraphObservation =
  | { status: 'complete'; root: Scope; nodes: readonly UwNativeNode[]; observedAt: string }
  | {
      status: 'incomplete'
      root: Scope
      nodes: readonly UwNativeNode[]
      observedAt: string | null
      diagnostics: readonly UwDiagnostic[]
    }
export type UwCheck = { ok: boolean; diagnostics: readonly UwDiagnostic[] }
export function scopeKey(value: Scope): string {
  return `${value.repository}\u0000${value.target}`
}
export function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}
export function knownWayfinderLabels(node: UwNativeNode): readonly string[] {
  return node.labels.filter((label) => (WAYFINDER_LABELS as readonly string[]).includes(label))
}
export function unknownWayfinderLabels(node: UwNativeNode): readonly string[] {
  return node.labels.filter(
    (label) => label.startsWith('wayfinder:') && !(WAYFINDER_LABELS as readonly string[]).includes(label),
  )
}
export function isWayfinder(node: UwNativeNode): boolean {
  return knownWayfinderLabels(node).length > 0
}
function diag(
  uw: Scope,
  code: string,
  message: string,
  connection: UwDiagnostic['location'] extends infer T
    ? T extends { kind: 'native'; connection: infer C }
      ? C
      : never
    : never,
): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection }, related: [] }
}
function incompleteGraph(graph: Extract<UwGraphObservation, { status: 'incomplete' }>): UwCheck {
  return {
    ok: false,
    diagnostics: graph.diagnostics.length
      ? graph.diagnostics
      : [diag(graph.root, 'graph-incomplete', 'Native graph is incomplete', 'state')],
  }
}

function appendChildren(
  node: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
  outgoing: string[],
  diagnostics: UwDiagnostic[],
): void {
  for (const child of node.children) {
    if (child.repository !== node.uw.repository)
      diagnostics.push({
        ...diag(node.uw, 'cross-repository-child', 'Child is cross-repository', 'children'),
        related: [{ kind: 'native', uw: child, connection: 'parent' }],
      })
    const childNode = nodes.get(scopeKey(child))
    if (!childNode) diagnostics.push(diag(node.uw, 'graph-incomplete', 'Child was not read', 'children'))
    else {
      outgoing.push(scopeKey(child))
      if (childNode.parent === null || !sameScope(childNode.parent, node.uw))
        diagnostics.push({
          ...diag(node.uw, 'parent-child-conflict', 'Child does not name this parent', 'children'),
          related: [{ kind: 'native', uw: child, connection: 'parent' }],
        })
    }
  }
}

function appendBlockers(
  node: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
  outgoing: string[],
  diagnostics: UwDiagnostic[],
): void {
  for (const blocker of node.blockers) {
    const blockerNode = nodes.get(scopeKey(blocker))
    if (!blockerNode) diagnostics.push(diag(node.uw, 'graph-incomplete', 'Blocker was not read', 'blockers'))
    else outgoing.push(scopeKey(blocker))
  }
}

function relationEdges(nodes: ReadonlyMap<string, UwNativeNode>, diagnostics: UwDiagnostic[]): Map<string, string[]> {
  const edges = new Map<string, string[]>()
  for (const node of nodes.values()) {
    const key = scopeKey(node.uw)
    const outgoing: string[] = []
    edges.set(key, outgoing)
    if (knownWayfinderLabels(node).some((label) => !node.wayfinderLabels.includes(label)))
      diagnostics.push(diag(node.uw, 'graph-incomplete', 'Wayfinder projection lost raw label', 'labels'))
    appendChildren(node, nodes, outgoing, diagnostics)
    appendBlockers(node, nodes, outgoing, diagnostics)
    if (node.parent !== null) {
      const parent = nodes.get(scopeKey(node.parent))
      if (!parent) diagnostics.push(diag(node.uw, 'graph-incomplete', 'Parent was not read', 'parent'))
      else if (!parent.children.some((child) => sameScope(child, node.uw)))
        diagnostics.push({
          ...diag(node.uw, 'parent-child-conflict', 'Parent does not list this child', 'parent'),
          related: [{ kind: 'native', uw: parent.uw, connection: 'children' }],
        })
      if (node.parent.repository !== node.uw.repository)
        diagnostics.push({
          ...diag(node.uw, 'cross-repository-child', 'Parent is cross-repository', 'parent'),
          related: [{ kind: 'native', uw: node.parent, connection: 'children' }],
        })
    }
  }
  return edges
}

export function cycleKeys(edges: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const cycles: string[] = []
  const walk = (key: string): void => {
    if (visiting.has(key)) {
      cycles.push(key)
      return
    }
    if (done.has(key)) return
    visiting.add(key)
    for (const next of edges.get(key) ?? []) walk(next)
    visiting.delete(key)
    done.add(key)
  }
  for (const key of edges.keys()) walk(key)
  return cycles
}

function appendCycles(
  nodes: ReadonlyMap<string, UwNativeNode>,
  edges: ReadonlyMap<string, readonly string[]>,
  diagnostics: UwDiagnostic[],
): void {
  for (const key of cycleKeys(edges)) {
    const node = nodes.get(key)
    if (node) diagnostics.push(diag(node.uw, 'graph-cycle', 'Combined hierarchy/blocker cycle', 'state'))
  }
}

function appendParentClaimDiagnostics(
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
  diagnostics: UwDiagnostic[],
): void {
  const parents = new Map<string, Scope[]>()
  for (const node of graph.nodes) {
    for (const child of node.children) {
      const key = scopeKey(child)
      const claims = parents.get(key) ?? []
      if (!claims.some((claim) => sameScope(claim, node.uw))) claims.push(node.uw)
      parents.set(key, claims)
    }
  }
  for (const node of graph.nodes) {
    const claims = parents.get(scopeKey(node.uw)) ?? []
    const parent = node.parent
    if (parent && !claims.some((claim) => sameScope(claim, parent))) claims.push(parent)
    if (claims.length > 1)
      diagnostics.push({
        ...diag(node.uw, 'multiple-parents', 'Child has multiple parent claims', 'parent'),
        related: claims.map((uw) => ({ kind: 'native' as const, uw, connection: 'children' as const })),
      })
  }
}

function collectObservedNodes(
  observed: readonly UwNativeNode[],
  diagnostics: UwDiagnostic[],
): Map<string, UwNativeNode> {
  const nodes = new Map<string, UwNativeNode>()
  for (const node of observed) {
    const key = scopeKey(node.uw)
    const previous = nodes.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(node))
      diagnostics.push(
        diag(node.uw, 'graph-conflicting-observation', 'Conflicting native observations for the same UW', 'state'),
      )
    else if (!previous) nodes.set(key, node)
  }
  return nodes
}

export function relationGraph(observed: readonly UwNativeNode[]): {
  edges: ReadonlyMap<string, readonly string[]>
  diagnostics: readonly UwDiagnostic[]
} {
  const diagnostics: UwDiagnostic[] = []
  const nodes = collectObservedNodes(observed, diagnostics)
  return { edges: relationEdges(nodes, diagnostics), diagnostics }
}

export function validateUwGraph(graph: UwGraphObservation): UwCheck {
  if (graph.status === 'incomplete') return incompleteGraph(graph)
  const diagnostics: UwDiagnostic[] = []
  appendParentClaimDiagnostics(graph, diagnostics)
  const nodes = collectObservedNodes(graph.nodes, diagnostics)
  if (!nodes.has(scopeKey(graph.root)))
    diagnostics.push(diag(graph.root, 'graph-incomplete', 'Root was not read', 'state'))
  const edges = relationEdges(nodes, diagnostics)
  appendCycles(nodes, edges, diagnostics)
  return { ok: diagnostics.length === 0, diagnostics }
}
