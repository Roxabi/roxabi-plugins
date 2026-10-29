import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwRead } from './uw-contract.ts'

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function issueOf(scope: Scope): IssueRef {
  const prefix = `${scope.repository}#`
  if (!scope.target.startsWith(prefix)) throw new Error(`UW scope target is not an issue reference: ${scope.target}`)
  const number = Number(scope.target.slice(prefix.length))
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`UW scope target is not an issue number: ${scope.target}`)
  return { repository: scope.repository, number }
}

export function rootObservation(uw: Scope, read: UwRead): IssueWriteObservation {
  if (read.graph.status !== 'complete') throw new Error(`UW native graph is incomplete: ${uw.target}`)
  const root = read.graph.nodes.find((node) => sameScope(node.uw, uw))
  if (root === undefined) throw new Error(`UW graph root is missing: ${uw.target}`)
  return {
    issue: issueOf(root.uw),
    title: root.title,
    body: root.raw.body,
    updatedAt: root.updatedAt,
    labels: root.labels,
    parent: root.parent === null ? null : issueOf(root.parent),
    children: root.children.map(issueOf),
    blockers: root.blockers.map(issueOf),
  }
}
