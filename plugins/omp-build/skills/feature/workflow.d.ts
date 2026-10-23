/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

import type { DecodedHistory, Result, ReviewSummary } from '../../dist/contracts.js'
import type {
  Git,
  PrComment,
  ProofConfigPin,
  ProofSemanticContext,
  ProofSummary,
  captureReviewInput as proofReviewInput,
  Refusal,
  reviewSemanticCanon,
} from './proof'

type Gh = (cwd: string, args: string[]) => Promise<string>

export declare function readLanding(
  cwd: string,
  opts: { base: string },
): {
  mode: 'native' | 'merge-on-green'
  required_checks: string[]
}

/** Bind an explicit PR or discover the sole same-repository open PR for the current branch. */
export declare function resolveReviewPr(
  cwd: string,
  explicitPr?: number | string | null,
  deps?: { gh?: Gh; git?: Git },
): Promise<number | null>

export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<{ disarmed: true } | { unarmed: true } | { closed: true } | { merged: true }>

/** Summarizes only decoded canonical records; malformed, legacy and partial records refuse. */
export declare function reviewRecords(
  history: DecodedHistory,
  options?: { taxonomy?: readonly string[]; acceptedEvidencePolicyRef?: string | null },
): Result<ReviewSummary>

export declare function readReviewRecords(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; taxonomy?: readonly string[]; acceptedEvidencePolicyRef?: string | null },
): Promise<Result<ReviewSummary>>

/** Lossless, non-throwing git: exit code and both streams exactly as printed. */
export declare function gitResult(
  cwd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }>

/** The automation login, then every comment of `pr` in creation order; an unreadable source throws. */
export declare function readComments(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh },
): Promise<{
  me: string
  comments: PrComment[]
}>

/** Pure transition from already-read records. No arm, disarm, or publication. */
export declare function reviewStep(
  records: { reviews: number; verdict: string | null; head: string | null; spent: boolean },
  at: { head: unknown; ciFailed?: boolean },
): {
  action: 'review' | 'fix' | 'land' | 'stop'
  reviews: number
  remaining?: number
  reason?: string
  message?: string
}

/** Progress selector only. It does not admit landing; landPr and CI allow exits do. */
export declare function nextReviewStep(
  cwd: string,
  pr: number | string,
  opts?: { ciFailed?: boolean; reviewing?: boolean; gh?: Gh; git?: Git },
): Promise<{
  action: 'review' | 'fix' | 'land' | 'stop'
  reviews: number
  remaining?: number
  reason?: string
  message?: string
  disarmed?: true
}>

type ReviewCapture = Pick<
  Extract<Awaited<ReturnType<typeof proofReviewInput>>, { ok: true }>,
  'ok' | 'input' | 'body' | 'semctx' | 'assertledger'
> & {
  /** Exact context hashed when proof capture reached the canon. Same object when the caller supplied it. */
  semantic: ProofSemanticContext
  /** `reviewSemanticCanon(semantic)`. Preparation must use this, not a second resolve. */
  semanticCanon: ReturnType<typeof reviewSemanticCanon>
}
/** Read-only review input capture at the already selected head; no gate or producer writes. */
export declare function captureReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  deps?: { gh?: Gh; git?: Git; semantic?: ProofSemanticContext },
): Promise<ReviewCapture | Refusal>
/** Invalid or drifted review context refuses before a proof hash. Absent binding is not landing authority. */
export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  gh: Gh,
  base: string,
): Promise<ProofSemanticContext | Refusal>

/** Refuse changed inputs before posting, without replacing the retained capture. */
export declare function validateReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  input: string | null,
  deps?: { gh?: Gh; git?: Git },
): Promise<{ ok: true } | Refusal>

export declare function openPr(
  cwd: string,
  input: { issue: number; branch: string; base: string; title: string; body?: string },
  deps?: { gh?: Gh },
): Promise<{ number: number; status: 'created' | 'existing' }>

export declare function landPr(
  cwd: string,
  pr: number | string,
  opts?: {
    gh?: Gh
    git?: Git
    requiredContexts?: string[]
    landing?: { mode: string; required_checks: string[] }
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{
  /** `behind`: OPEN and BEHIND — no further arming; known OPEN arms (including this call's earlier pin) cleared. `error` names `gh pr update-branch <pr>`. A failed clear throws naming the remainder; a merge during it is `merged`. See `landPr`'s behind exit and `applyCiWatchExit` in `skills/feature/workflow.js`. */
  status: string
  mode?: string
  watch?: string
  /** `not-approved`: `review-bound` | `review-unbound` | `head-moved`. `proof-blocked`: `unreadable` | `ambiguous` | `missing` | `unbound` | `verdict` | `unjustified`. `mandate-refused`: the engine landing refusal, never an approval. */
  reason?: string
  /** `proof-blocked` only: whose evidence refused — the candidate binding itself, Semctx or assertledger. */
  producer?: 'candidate' | 'semctx' | 'assertledger'
  /** Only `true`, only when a read-back confirmed the disarm; never a no-op claim. */
  disarmed?: true
  /** `auto-merge-failed` only: `false` after a confirmed clear or a refused pin (not a clear claim), `true` when something stays armed. */
  armed?: boolean
  /** `watching` only: what the landing admission admitted for the armed candidate — Semctx `absent` or its native VERIFIED/PARTIAL result with each PARTIAL gap's NO TEST reason, and assertledger `not-applicable` or `detection`. */
  proof?: ProofSummary
  /** The reason for `bad-landing` or `watch-failed`; for `behind`, the command `gh pr update-branch <pr>`; for `proof-blocked`, what must be produced outside admission; for `auto-merge-failed`, what stays armed or why the gate was disarmed. Only two fragments are contract: the remaining arms follow `stays armed — <arms>`, and unconfirmed state is named by `could not be read back`. The prefix and causal prose around them are not a stable API. */
  error?: string
}>

export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  opts?: { gh?: Gh; git?: Git; mode?: string },
): Promise<{
  /** Exit 7 is `behind`; with exit 0–3 and 7 a merged PR is `merged` and a closed one `stopped`. */
  status: string
  disarmed?: true
  /** `behind`: `gh pr update-branch <pr>`. `mandate-refused`: the engine refusal evidence. */
  reason?: string
  /** Present when a watching exit already built the ci-watch command. */
  watch?: string
}>

/** Closed re-entry after a non-Epic stop. `none` does not continue the landing cycle. */
export type FeatureLandReentry =
  | 'none'
  | 'review-when-head-readable'
  | 'rerun-ci-then-land'
  | 'resolve-checks-then-land'
  | 'update-branch-then-land'
  | 'manual-merge'
  | 'fix-landing-config-then-land'
  | 'resolve-check-enforcement-then-land'
  | 'clear-remainder-by-hand'
  | 'acquire'
  | 'acquire-then-review'
  | 'same-head-review'
  | 'obtain-native-metadata'
  | 'after-named-cause'

/** Shared landing-mandate check. A refusal never arms. Absent binding refuses (missing); never grants landing. */
export type LandingMandateDecision =
  | { admitted: true; recordId: string; proofPins: ProofConfigPin[] }
  | { admitted: false; reason: string; evidence?: unknown }

export declare function currentLandingMandate(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  native: { head: string; base: string; baseTip: string },
  gitFn?: Git,
  gitCwd?: string,
): Promise<LandingMandateDecision>

export type FeatureLandOutcome =
  | { action: 'start-watch'; claimMerged: false; reportProof: true }
  | { action: 'reattach-watch'; claimMerged: false }
  | { action: 'next-review-step'; ciFailed: boolean; claimMerged: false; reason?: 'head-moved' }
  | { action: 'review-if-unspent'; claimMerged: false; reason: string }
  | { action: 'report-merged'; claimMerged: true; offerTail: true }
  | {
      action: 'stop'
      claimMerged: false
      reason: string
      reenter: FeatureLandReentry
      reviewAgain?: false
      bound?: 'sticky'
      producer?: 'candidate' | 'semctx' | 'assertledger' | null
      proofReason?: string | null
      producerAtAdmission?: false
      startWatch?: false
      updateBranchFromCycle?: false
      wait?: false
      report?: string
      doc?: 'docs/kit/ci-app-setup.md'
      retainArm?: 'current-authorization-only'
      armed?: boolean
      mandateReason?: string
    }
  | { action: 'blocked'; claimMerged: false; reason: 'unknown-land-status' | 'watch-missing'; status: string }

/**
 * Non-Epic map of a `landPr` / `applyCiWatchExit` status. Epic keeps `landOutcome`.
 * Unknown status is `blocked`, never a watch, review, or merge claim.
 */
export declare function featureLandOutcome(land: {
  status?: string
  reason?: string
  producer?: 'candidate' | 'semctx' | 'assertledger'
  error?: string
  code?: number
  armed?: boolean
  watch?: string
}): FeatureLandOutcome
