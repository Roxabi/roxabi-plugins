import type { PrComment, ProofConfigPin } from './proof-base'

/** Approval publication time and the retained exact review-input digest are separate constraints. */
export type Target = {
  pr: number
  candidate: string
  base: string | undefined
  baseTip: string
  reviewedAt: string | null
  reviewInput: string | null
  /** Approved mandate pins. Production landing passes this; omission is not approval. */
  proofPins?: readonly ProofConfigPin[]
}

export type SelectedRecord = { record: unknown; recordId: string; parts: PrComment[] }
