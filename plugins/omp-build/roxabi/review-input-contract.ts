import type { Json, Policy, Scope } from '../dist/contracts.js'
import type { AllocateReviewInput, ReviewTier } from '../skills/dev-review/roster-contract'
import type { ReviewConfig } from './review-assets'
import type { ReviewPrompts, ReviewSemanticAssets, SpecDisplay } from './review-prompts'
import type { ConfirmedReviewSemanticContext } from './review-semantic-canon'
import type { ReviewSemanticContext } from './review-semantic-context'
import type { ActionInputs, PreparedUwAction, TrustedHostPluginPin, UwActionRequest } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import type { ReviewIssueSpec } from './uw-spec'
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
  inputSnapshot: ActionInputs
  issueSpec: ReviewIssueSpec | null
  semanticContext: ReviewSemanticContext
  tier: ReviewTier
  warnings: string[]
  chunks: PreparedReviewChunk[]
  contextWindow: number
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  policy: Policy
  semantic: { assets: ReviewSemanticAssets; spec: SpecDisplay; prompts: ReviewPrompts }
  rawOperatorRequest: Json
  actions: Readonly<Record<string, PreparedUwAction>>
  operations: UwOperations
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
  operations: UwOperations
  /** Explicit host-supplied context for a fresh action; never populated by automatic continuation. */
  expansion?: Pick<UwActionRequest, 'stageSources' | 'expandedContext'>
  /** Trusted host composition only. Omit for the ordinary published pin. */
  pluginPin?: TrustedHostPluginPin
}
