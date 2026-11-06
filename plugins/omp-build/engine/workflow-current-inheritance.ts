import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameOwnSpecRef } from './record-diagnostics.ts'
import type { Scope } from './record-values.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { scopeKey, type UwGraphObservation, validateUwGraph } from './uw-graph.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { historyFor } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

/** Capture current authenticated ancestors without requiring the child's outdated own commitment to match. */
export function resolveCurrentInheritedOwnSpecRefs(
  uw: Scope,
  graph: UwGraphObservation,
  histories: readonly DecodedHistory[],
  assessmentReplay?: AssessmentReplayContext,
): UwResult<OwnSpecRef[]> {
  const invalid = (message: string): UwResult<OwnSpecRef[]> => ({
    ok: false,
    diagnostics: [
      {
        code: 'current-inheritance-unavailable',
        message,
        location: { kind: 'native', uw, connection: 'parent' },
        related: [],
      },
    ],
  })
  const checked = validateUwGraph(graph)
  if (!checked.ok) return { ok: false, diagnostics: [...checked.diagnostics] }
  const node = graph.nodes.find((entry) => equalScope(entry.uw, uw))
  if (!node) return invalid('Current UW is absent from the complete native graph')
  const seen = new Set([scopeKey(uw)])
  const ancestors: Array<{ ref: OwnSpecRef; inherited: readonly OwnSpecRef[] }> = []
  let parent = node.parent
  while (parent !== null) {
    const key = scopeKey(parent)
    if (seen.has(key)) return invalid('Native parent ancestry contains a cycle')
    seen.add(key)
    const parentScope = parent
    const native = graph.nodes.find((entry) => equalScope(entry.uw, parentScope))
    const history = historyFor(parentScope, histories)
    if (!native || history === null) return invalid('A native ancestor or its history is unavailable')
    const mandate = selectedMandate(history)
    if (!('kind' in mandate) || mandate.kind !== 'mandate')
      return invalid('A native ancestor has no uniquely active mandate')
    const accepted = resolveAcceptedSpec(mandate, histories, assessmentReplay)
    if (!accepted.ok) return invalid('A native ancestor accepted Spec cannot be authenticated')
    ancestors.push({ ref: accepted.spec.ref, inherited: accepted.spec.inheritedOwnSpecRefs })
    parent = native.parent
  }
  if (!consistentAncestorSuffixes(ancestors))
    return invalid('Current accepted ancestor inheritance disagrees with the native ancestry')
  return { ok: true, value: ancestors.map((ancestor) => ancestor.ref) }
}

function consistentAncestorSuffixes(
  ancestors: readonly { ref: OwnSpecRef; inherited: readonly OwnSpecRef[] }[],
): boolean {
  return ancestors.every((ancestor, index) => {
    const suffix = ancestors.slice(index + 1)
    return (
      ancestor.inherited.length === suffix.length &&
      ancestor.inherited.every((ref, i) => {
        const expected = suffix[i]
        return expected !== undefined && sameOwnSpecRef(ref, expected.ref)
      })
    )
  })
}
