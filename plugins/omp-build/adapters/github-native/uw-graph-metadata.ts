import type { Scope } from '../../engine/record-values.ts'
import type { UwDiagnostic } from '../../engine/uw-diagnostics.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { githubScope } from '../github/transport.ts'
import type { ConnectionName, GraphqlIssue, IssueRef } from './uw-graph-shape.ts'

function refScope(ref: IssueRef): Scope {
  return githubScope(ref.repository.nameWithOwner, ref.number)
}

export function sameMetadata(left: GraphqlIssue, right: GraphqlIssue): boolean {
  return (
    left.number === right.number &&
    left.repository.nameWithOwner === right.repository.nameWithOwner &&
    left.title === right.title &&
    left.body === right.body &&
    left.updatedAt === right.updatedAt &&
    left.state === right.state &&
    left.stateReason === right.stateReason &&
    (left.parent === null
      ? right.parent === null
      : right.parent !== null && scopeKey(refScope(left.parent)) === scopeKey(refScope(right.parent)))
  )
}

export function metadataChangeDiagnostic(
  scope: Scope,
  connection: Extract<ConnectionName, 'labels' | 'children' | 'blockers'>,
  pageNumber: number,
  cursor: string,
  base: GraphqlIssue,
  next: GraphqlIssue,
): UwDiagnostic {
  const firstParent = base.parent === null ? 'none' : refScope(base.parent).target
  const nextParent = next.parent === null ? 'none' : refScope(next.parent).target
  return {
    code: 'graph-incomplete',
    message: `Native metadata for ${scope.target} changed between pages (parents: ${firstParent}, ${nextParent})`,
    location: { kind: 'native', uw: scope, connection, page: pageNumber, cursor },
    related: [
      ...(base.parent === null
        ? []
        : [{ kind: 'native' as const, uw: refScope(base.parent), connection: 'children' as const }]),
      ...(next.parent === null
        ? []
        : [{ kind: 'native' as const, uw: refScope(next.parent), connection: 'children' as const }]),
    ],
  }
}
