import type { Scope } from '../../engine/record-values.ts'
import type { UwNativeNode } from '../../engine/uw-graph.ts'

export type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
export type IssueRef = { number: number; repository: { nameWithOwner: string } }
export type GraphqlIssue = {
  number: number
  title: string
  body: string
  updatedAt: string
  state: 'OPEN' | 'CLOSED'
  stateReason: string | null
  repository: { nameWithOwner: string }
  parent: IssueRef | null
  labels: Connection<{ name: string }>
  subIssues: Connection<IssueRef>
  blockedBy: Connection<IssueRef>
}
export type ConnectionName = 'parent' | 'children' | 'blockers' | 'labels' | 'state'
export type PartialNode = { node: UwNativeNode; labels: string[]; children: Scope[]; blockers: Scope[] }
