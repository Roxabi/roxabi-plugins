/**
 * Raw GraphQL response types shared across skills.
 */

export interface RawFieldValue {
  name?: string
  field?: { name?: string }
}

export interface RawSubIssue {
  number: number
  state: string
  title: string
}

export interface RawContent {
  number: number
  title: string
  state: string
  url: string
  body?: string
  subIssues?: { nodes: RawSubIssue[] }
  parent?: { number: number; state: string } | null
  blockedBy?: { nodes: { number: number; state: string }[] }
  blocking?: { nodes: { number: number; state: string }[] }
}

export interface RawItem {
  id?: string
  content: RawContent
  fieldValues: { nodes: RawFieldValue[] }
}
