import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwRead } from './uw-contract.ts'
export function issueRef(uw: Scope): IssueRef | null {
  const separator = uw.target.lastIndexOf('#')
  const number = Number(uw.target.slice(separator + 1))
  return separator < 1 || !Number.isSafeInteger(number) || number < 1 ? null : { repository: uw.repository, number }
}

export function observation(read: UwRead): IssueWriteObservation | null {
  const node = read.graph.nodes.find(
    (candidate) => candidate.uw.repository === read.uw.repository && candidate.uw.target === read.uw.target,
  )
  const issue = issueRef(read.uw)
  if (node === undefined || issue === null) return null
  return {
    issue,
    title: node.title,
    body: node.raw.body,
    updatedAt: node.updatedAt,
    nativeState: node.native,
    labels: node.labels,
    parent: node.parent === null ? null : issueRef(node.parent),
    children: node.children.flatMap((child) => {
      const ref = issueRef(child)
      return ref === null ? [] : [ref]
    }),
    blockers: node.blockers.flatMap((blocker) => {
      const ref = issueRef(blocker)
      return ref === null ? [] : [ref]
    }),
  }
}
