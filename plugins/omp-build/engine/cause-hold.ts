import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { DependencyResolution, UwWaitProjection } from './uw-completion-types.ts'
import { sameScope, scopeKey } from './uw-graph.ts'

/** A durable causal wait is lifted only by its projected resolution. */
export function assessCauseHolds(input: {
  uw: Scope
  waits: UwWaitProjection
  dependencies: ReadonlyMap<string, DependencyResolution>
}): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const problem of input.waits.diagnostics) {
    if (problem.location.kind === 'native' && sameScope(problem.location.uw, input.uw))
      diagnostics.push(diagnostic(problem.code, problem.message))
  }
  for (const wait of input.waits.causeWaits) {
    if (!sameScope(wait.origin, input.uw) || wait.state === 'withdrawn') continue
    if (wait.state === 'held') {
      diagnostics.push(...wait.diagnostics.map((problem) => diagnostic(problem.code, problem.message)))
      continue
    }
    if (input.dependencies.get(scopeKey(wait.target))?.state !== 'satisfied')
      diagnostics.push({
        ...diagnostic('cause-sister-incomplete', 'Blocking sister completion is not established'),
        recordId: wait.disposition.recordId,
      })
  }
  return diagnostics
}
