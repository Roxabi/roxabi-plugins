import type { Scope } from './record-values.ts'
import type { AcceptedOwnSpecResult } from './uw-admission.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import {
  isWayfinder,
  sameScope,
  scopeKey,
  type UwGraphObservation,
  type UwNativeNode,
  unknownWayfinderLabels,
} from './uw-graph.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'

export type NativeUwChildrenProjection =
  | { ok: true; value: readonly UwNativeNode[] }
  | { ok: false; diagnostics: readonly UwDiagnostic[] }

function diag(
  uw: Scope,
  code: string,
  message: string,
  connection: 'children',
  related?: { uw: Scope; connection: 'labels' | 'state' },
): UwDiagnostic {
  return {
    code,
    message,
    location: { kind: 'native', uw, connection },
    related: related ? [{ kind: 'native', ...related }] : [],
  }
}

function checkAcceptedChildren(
  uw: Scope,
  root: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
  accepted: readonly AcceptedChildCommitment[] | null,
  diagnostics: UwDiagnostic[],
): void {
  for (const child of accepted ?? []) {
    if (!root.children.some((scope) => sameScope(scope, child.scope)))
      diagnostics.push(
        diag(
          uw,
          'material-change-pending',
          `Accepted child ${child.scope.target} was removed from native children`,
          'children',
          { uw: child.scope, connection: 'state' },
        ),
      )
    else {
      const native = nodes.get(scopeKey(child.scope))
      if (native === undefined)
        diagnostics.push(
          diag(uw, 'graph-incomplete', `Accepted child ${child.scope.target} was not read`, 'children', {
            uw: child.scope,
            connection: 'state',
          }),
        )
      else if (isWayfinder(native))
        diagnostics.push(
          diag(
            uw,
            'material-change-pending',
            `Accepted child ${child.scope.target} was reclassified as wayfinder`,
            'children',
            { uw: child.scope, connection: 'labels' },
          ),
        )
    }
  }
}

function collectNativeChildren(
  uw: Scope,
  root: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
  accepted: readonly AcceptedChildCommitment[] | null,
  diagnostics: UwDiagnostic[],
  children: UwNativeNode[],
): void {
  for (const scope of root.children) {
    const native = nodes.get(scopeKey(scope))
    if (native === undefined) {
      diagnostics.push(
        diag(uw, 'graph-incomplete', `Native child ${scope.target} was not read`, 'children', {
          uw: scope,
          connection: 'state',
        }),
      )
    } else if (unknownWayfinderLabels(native).length) {
      diagnostics.push(
        diag(uw, 'wayfinder-unknown', `Child ${scope.target} has an unknown wayfinder label`, 'children', {
          uw: scope,
          connection: 'labels',
        }),
      )
    } else if (!isWayfinder(native)) {
      children.push(native)
      if (accepted !== null && !accepted.some((child) => sameScope(child.scope, scope)))
        diagnostics.push(
          diag(uw, 'material-change-pending', `Native UW child ${scope.target} was added`, 'children', {
            uw: scope,
            connection: 'state',
          }),
        )
    }
  }
}

/**
 * Project deliverable UW children without erasing accepted commitments before
 * checking native membership and wayfinder reclassification.
 */
export function projectNativeUwChildren(input: {
  uw: Scope
  graph: UwGraphObservation
  accepted: AcceptedOwnSpecResult
}): NativeUwChildrenProjection {
  if (input.graph.status === 'incomplete') return incompleteGraph(input.uw, input.graph)
  if (input.accepted.status === 'refused') return { ok: false, diagnostics: input.accepted.diagnostics }
  return projectCompleteChildren(
    input.uw,
    input.graph,
    input.accepted.status === 'accepted' ? input.accepted.value.children : null,
  )
}

/** Null means no commitment baseline; an empty array is an authenticated historical leaf. */
export function projectNativeUwChildrenAgainstCommitments(input: {
  uw: Scope
  graph: UwGraphObservation
  commitments: readonly AcceptedChildCommitment[] | null
}): NativeUwChildrenProjection {
  if (input.graph.status === 'incomplete') return incompleteGraph(input.uw, input.graph)
  return projectCompleteChildren(input.uw, input.graph, input.commitments)
}

function incompleteGraph(
  uw: Scope,
  graph: Extract<UwGraphObservation, { status: 'incomplete' }>,
): NativeUwChildrenProjection {
  return {
    ok: false,
    diagnostics: graph.diagnostics.length
      ? graph.diagnostics
      : [diag(uw, 'graph-incomplete', 'Native graph is incomplete', 'children')],
  }
}

function projectCompleteChildren(
  uw: Scope,
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
  commitments: readonly AcceptedChildCommitment[] | null,
): NativeUwChildrenProjection {
  const nodes = new Map<string, UwNativeNode>()
  for (const node of graph.nodes) nodes.set(scopeKey(node.uw), node)
  const root = nodes.get(scopeKey(uw))
  if (root === undefined)
    return { ok: false, diagnostics: [diag(uw, 'graph-incomplete', 'Selected UW is absent', 'children')] }
  const diagnostics: UwDiagnostic[] = []
  checkAcceptedChildren(uw, root, nodes, commitments, diagnostics)
  const children: UwNativeNode[] = []
  collectNativeChildren(uw, root, nodes, commitments, diagnostics, children)
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: children }
}
