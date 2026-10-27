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
      diagnostics.push(diag(node.uw, 'cross-repository-child', 'Child is cross-repository', 'children'))
    const childNode = nodes.get(scopeKey(child))
    if (!childNode) diagnostics.push(diag(node.uw, 'graph-incomplete', 'Child was not read', 'children'))
    else if (!isWayfinder(childNode)) outgoing.push(scopeKey(child))
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
    else if (!isWayfinder(blockerNode)) outgoing.push(scopeKey(blocker))
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
    // Known wayfinder nodes stay in the observation set for reclassification,
    // but do not contribute UW wait edges (D41).
    if (isWayfinder(node)) continue
    appendChildren(node, nodes, outgoing, diagnostics)
    appendBlockers(node, nodes, outgoing, diagnostics)
    if (node.parent !== null && !nodes.has(scopeKey(node.parent)))
      diagnostics.push(diag(node.uw, 'graph-incomplete', 'Parent was not read', 'parent'))
  }
  return edges
}

function appendCycles(
  nodes: ReadonlyMap<string, UwNativeNode>,
  edges: ReadonlyMap<string, readonly string[]>,
  diagnostics: UwDiagnostic[],
): void {
  const visiting = new Set<string>()
  const done = new Set<string>()
  const walk = (key: string): void => {
    if (visiting.has(key)) {
      const node = nodes.get(key)
      if (node) diagnostics.push(diag(node.uw, 'graph-cycle', 'Combined hierarchy/blocker cycle', 'state'))
      return
    }
    if (done.has(key)) return
    visiting.add(key)
    for (const next of edges.get(key) ?? []) walk(next)
    visiting.delete(key)
    done.add(key)
  }
  for (const key of nodes.keys()) walk(key)
}

export function validateUwGraph(graph: UwGraphObservation): UwCheck {
  if (graph.status === 'incomplete') return incompleteGraph(graph)
  const diagnostics: UwDiagnostic[] = []
  const nodes = new Map(graph.nodes.map((node) => [scopeKey(node.uw), node]))
  if (!nodes.has(scopeKey(graph.root)))
    diagnostics.push(diag(graph.root, 'graph-incomplete', 'Root was not read', 'state'))
  const edges = relationEdges(nodes, diagnostics)
  appendCycles(nodes, edges, diagnostics)
  return { ok: diagnostics.length === 0, diagnostics }
}
