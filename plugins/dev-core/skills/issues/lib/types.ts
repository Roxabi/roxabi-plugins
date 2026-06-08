/**
 * Types for the issues skill: shared re-exports + local domain types.
 */

export type { RawContent, RawFieldValue, RawItem, RawSubIssue } from '../../shared/types'

import type { CheckConclusionState, CheckStatusState, StatusState } from './gh-enums'

export interface Issue {
  number: number
  title: string
  url: string
  status: string
  size: string
  priority: string
  blockStatus: 'ready' | 'blocked' | 'blocking'
  blockedBy: { number: number; state: string }[]
  blocking: { number: number; state: string }[]
  children: Issue[]
  projectLabel?: string
  inProjects?: string[]
}

export interface CICheck {
  name: string
  status: CheckStatusState | StatusState | ''
  conclusion: CheckConclusionState | ''
  detailsUrl: string
}
