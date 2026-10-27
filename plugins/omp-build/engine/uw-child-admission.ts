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
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

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
  accepted: AcceptedOwnSpec['children'] | null,
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
  accepted: AcceptedOwnSpec['children'] | null,
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
}): { ok: true; value: readonly UwNativeNode[] } | { ok: false; diagnostics: readonly UwDiagnostic[] } {
  if (input.graph.status === 'incomplete')
    return {
      ok: false,
      diagnostics: input.graph.diagnostics.length
        ? input.graph.diagnostics
        : [diag(input.uw, 'graph-incomplete', 'Native graph is incomplete', 'children')],
    }
  if (input.accepted.status === 'refused') return { ok: false, diagnostics: input.accepted.diagnostics }
  const nodes = new Map(input.graph.nodes.map((node) => [scopeKey(node.uw), node]))
  const root = nodes.get(scopeKey(input.uw))
  if (root === undefined)
    return { ok: false, diagnostics: [diag(input.uw, 'graph-incomplete', 'Selected UW is absent', 'children')] }
  const diagnostics: UwDiagnostic[] = []
  const accepted = input.accepted.status === 'accepted' ? input.accepted.value.children : null
  checkAcceptedChildren(input.uw, root, nodes, accepted, diagnostics)
  const children: UwNativeNode[] = []
  collectNativeChildren(input.uw, root, nodes, accepted, diagnostics, children)
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: children }
}
