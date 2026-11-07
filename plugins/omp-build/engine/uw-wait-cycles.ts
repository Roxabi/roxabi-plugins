import type { Scope } from './record-values.ts'
import type { WaitRequirement } from './uw-completion-types.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { sameScope, scopeKey } from './uw-graph.ts'

/** Cycle check over the union of native, coverage and causal wait edges. */
export function waitCycleDiagnostics(requirements: readonly WaitRequirement[]): UwDiagnostic[] {
  const outgoing = new Map<string, WaitRequirement[]>()
  const scopes = new Map<string, Scope>()
  for (const edge of requirements) {
    const key = scopeKey(edge.from)
    scopes.set(key, edge.from)
    scopes.set(scopeKey(edge.to), edge.to)
    const edges = outgoing.get(key) ?? []
    edges.push(edge)
    outgoing.set(key, edges)
  }
  const diagnostics: UwDiagnostic[] = []
  const active = new Set<string>()
  const done = new Set<string>()
  const path: WaitRequirement[] = []
  const visit = (scope: Scope): void => {
    const key = scopeKey(scope)
    if (active.has(key)) {
      const start = path.findIndex((edge) => sameScope(edge.from, scope))
      const cycle = path.slice(Math.max(start, 0))
      diagnostics.push({
        code: 'wait-cycle',
        message: `Combined wait cycle: ${cycle.map((edge) => `${edge.from.repository}#${edge.from.target} -${edge.source.kind}-> ${edge.to.repository}#${edge.to.target}`).join('; ')}`,
        location: { kind: 'native', uw: scope, connection: 'state' },
        related: cycle.map((edge) => ({
          kind: 'native' as const,
          uw: edge.from,
          connection:
            edge.source.kind === 'native-child' || edge.source.kind === 'accepted-child'
              ? ('children' as const)
              : ('blockers' as const),
        })),
      })
      return
    }
    if (done.has(key)) return
    active.add(key)
    for (const edge of outgoing.get(key) ?? []) {
      path.push(edge)
      visit(edge.to)
      path.pop()
    }
    active.delete(key)
    done.add(key)
  }
  for (const scope of scopes.values()) visit(scope)
  return diagnostics
}
