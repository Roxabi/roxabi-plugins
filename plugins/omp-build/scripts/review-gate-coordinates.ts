import type { githubScope } from '../dist/contracts.js'
import type { deriveReviewState, summarizeReviews } from '../engine/review-state.ts'
import type { Gh, Git } from '../skills/feature/review-base.ts'
import type { MachineResult } from './review-gate-cli.ts'

const SHA = /^[0-9a-f]{40}$/

export type Coordinates = { head: string; baseName: string; recordedBaseOid: string }
type ReviewSummary = ReturnType<typeof summarizeReviews>
export type AcceptedSummary = Extract<ReviewSummary, { ok: true }>
export type ReviewState = ReturnType<typeof deriveReviewState>
export type AcceptedReviewState = Extract<ReviewState, { ok: true }>
export type GateContext = {
  gh: Gh
  git: Git
  scope: ReturnType<typeof githubScope>
  taxonomy: string[]
  summary: AcceptedSummary
  coordinates: Coordinates
  baseTip: string
}
export type InitialReview = GateContext | { refusal: MachineResult }

export function currentHeadAndBase(raw: string): Coordinates {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('GitHub returned unreadable PR coordinates')
  }
  const fields = value as { headRefOid?: unknown; baseRefName?: unknown; baseRefOid?: unknown }
  if (
    !SHA.test(String(fields.headRefOid)) ||
    typeof fields.baseRefName !== 'string' ||
    fields.baseRefName.length === 0 ||
    !SHA.test(String(fields.baseRefOid))
  ) {
    throw new Error('GitHub returned incomplete PR coordinates')
  }
  return {
    head: fields.headRefOid as string,
    baseName: fields.baseRefName,
    recordedBaseOid: fields.baseRefOid as string,
  }
}
