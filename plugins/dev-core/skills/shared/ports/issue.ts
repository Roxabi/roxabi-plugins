/**
 * IssuePort — role interface for issue CRUD, labels, and comments.
 */
import type { Issue } from '../domain/types'

export interface IssueFilters {
  state?: 'OPEN' | 'CLOSED' | 'all'
  labels?: string[]
  search?: string
}

export interface IssuePort {
  getIssue(number: number): Promise<Issue>
  listIssues(filters?: IssueFilters): Promise<Issue[]>
  getNodeId(number: number): Promise<string>
  createIssue(title: string, body?: string, labels?: string[]): Promise<{ url: string; number: number }>
  updateLabels(number: number, add: string[], remove: string[]): Promise<void>
  addComment(number: number, body: string): Promise<void>
  getParentNumber(number: number): Promise<number | null>
}
