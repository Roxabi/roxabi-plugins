import type { Json, Policy, ReviewInputSnapshot, Scope } from '../dist/contracts.js'
import type { AllocateReviewInput, ReviewTier } from '../skills/dev-review/roster-contract'
import type { ReviewConfig } from './review-config'
import type { ReviewPrompts, ReviewSemanticAssets, SpecDisplay } from './review-prompts'
import type { ConfirmedReviewSemanticContext } from './review-semantic-canon'
import type { ReviewIssueSpec, ReviewSemanticContext } from './review-semantic-context'
export type ReviewInputCapture = {
  ok: true
  input: string | null
  body: { body: string; lastEditedAt: string | null } | null
  semantic: ConfirmedReviewSemanticContext
  semanticCanon: string
}
export type ObservedEvidence = {
  reviewInput: string | null
  candidate: { head: string; base: string }
  pullRequest: ReviewInputCapture['body']
  stack: { candidate: string | null; base: string | null }
  resolvedSpec: { reference: string; body: string; lastEditedAt: string | null } | null
  semanticContext?: ReviewSemanticContext
}
export type ReviewFile = {
  path: string
  oldPath?: string
  hunk?: string
  text: string | null
  deleted: boolean
  binary: boolean
}
export type PreparedReviewChunk = { index: number; delta: string[]; diff: string; files: ReviewFile[]; digest: string }
export type PreparedReviewInputs = {
  scope: Scope
  context: Scope & { number: number; candidateGitSHA: string; input: string | null; subject: { kind: 'pull-request' } }
  pr: { number: number; head: string; base: string; baseGitSHA: string; branch: string }
  automationLogin: string
  capture: ReviewInputCapture
  observedEvidence: ObservedEvidence
  inputSnapshot: ReviewInputSnapshot
  issueSpec: ReviewIssueSpec | null
  semanticContext: ReviewSemanticContext
  tier: ReviewTier
  warnings: string[]
  chunks: PreparedReviewChunk[]
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  policy: Policy
  semantic: { assets: ReviewSemanticAssets; spec: SpecDisplay; prompts: ReviewPrompts }
  rawOperatorRequest: Json
}
export type Gh = (cwd: string, args: string[]) => Promise<string>
export type GitResult = { code: number; stdout: string; stderr: string }
export type Git = (cwd: string, args: string[]) => Promise<GitResult>
export type PrepareReviewInputsOptions = {
  cwd: string
  pr?: number | string
  contextWindow: number
  gh?: Gh
  git?: Git
}
