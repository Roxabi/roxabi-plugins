import type { PrComment } from './proof-base'

/** Approval publication time and the retained exact review-input digest are separate constraints. */
export type Target = {
  pr: number
  candidate: string
  base: string | undefined
  baseTip: string
  reviewedAt: string | null
  reviewInput: string | null
}

export type SelectedRecord = { record: unknown; recordId: string; parts: PrComment[] }
