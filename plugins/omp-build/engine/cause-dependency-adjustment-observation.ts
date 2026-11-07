import { canonicalValueDigest } from './action-input.ts'
import type { Scope } from './record-values.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { scopeKey, type UwNativeNode } from './uw-graph.ts'
import { type NativeIssueObservation, nativeObservationDigest } from './uw-native-observation-schema.ts'

function issue(scope: Scope): NativeIssueObservation['issue'] | null {
  const prefix = `${scope.repository}#`
  const suffix = scope.target.startsWith(prefix) ? scope.target.slice(prefix.length) : ''
  const number = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : NaN
  return Number.isSafeInteger(number) && number > 0 ? { repository: scope.repository, number } : null
}

export function native(node: UwNativeNode): NativeIssueObservation | null {
  const id = issue(node.uw)
  const parent = node.parent === null ? null : issue(node.parent)
  const children = node.children.map(issue)
  const blockers = node.blockers.map(issue)
  if (
    id === null ||
    (node.parent !== null && parent === null) ||
    children.some((item) => item === null) ||
    blockers.some((item) => item === null)
  )
    return null
  return {
    issue: id,
    title: node.title,
    body: node.raw.body,
    updatedAt: node.updatedAt,
    nativeState: node.native,
    labels: [...node.labels],
    parent,
    children: children as NativeIssueObservation['children'],
    blockers: blockers as NativeIssueObservation['blockers'],
  }
}

export function inventory(observation: UwCompletionObservation) {
  const histories = observation.histories
    .map((item) => ({ scope: item.source.scope, digest: canonicalValueDigest(item) }))
    .sort((a, b) => scopeKey(a.scope).localeCompare(scopeKey(b.scope)))
  const nodes = observation.graph.nodes.map((node) => ({ scope: node.uw, value: native(node) }))
  if (
    new Set(histories.map((item) => scopeKey(item.scope))).size !== histories.length ||
    new Set(nodes.map((item) => scopeKey(item.scope))).size !== nodes.length ||
    observation.histories.some((item) => !item.source.complete)
  )
    return null
  const rows: { uw: Scope; digest: string }[] = []
  for (const entry of nodes) {
    if (entry.value === null) return null
    rows.push({ uw: entry.scope, digest: nativeObservationDigest(entry.value) })
  }
  const nativeGraph = {
    root: observation.graph.root,
    rows: rows.sort((a, b) => scopeKey(a.uw).localeCompare(scopeKey(b.uw))),
  }
  return { histories, nativeGraph }
}
