/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

import type { Git, PrComment, ProofSummary, captureReviewInput as proofReviewInput, Refusal } from './proof'

type Gh = (cwd: string, args: string[]) => Promise<string>

export declare function readLanding(
  cwd: string,
  opts: { base: string },
): {
  mode: 'native' | 'merge-on-green'
  required_checks: string[]
}

export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<{ disarmed?: true }>

/** The latest author-bound review's verdict, head, exact input marker, creation time and sticky bound. */
export declare function reviewRecords(
  comments: { body: string; author: { login: string } | null; createdAt?: string }[],
  options: { me: string },
): {
  reviews: number
  verdict: string | null
  head: string | null
  input: string | null
  at: string | null
  spent: boolean
}

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

type ReviewCapture = Pick<
  Extract<Awaited<ReturnType<typeof proofReviewInput>>, { ok: true }>,
  'ok' | 'input' | 'body' | 'semctx' | 'assertledger'
>
/** Read-only review input capture at the already selected head; no gate or producer writes. */
export declare function captureReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  deps?: { gh?: Gh; git?: Git },
): Promise<ReviewCapture | Refusal>
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
  /** `behind`: OPEN and BEHIND — no further arming; known OPEN arms (including this call's earlier pin) cleared. `error` names `gh pr update-branch <pr>`. A failed clear throws naming the remainder; a merge during it is `merged`. See SKILL.md §6.7. */
  status: string
  mode?: string
  watch?: string
  /** `not-approved`: `review-bound` | `no-review-head` | `head-moved`. `proof-blocked`: `unreadable` | `ambiguous` | `missing` | `unbound` | `verdict` | `unjustified`. */
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
  opts?: { mode?: string },
): Promise<{
  /** Exit 7 is `behind`; with exit 0–3 and 7 a merged PR is `merged` and a closed one `stopped`. */
  status: string
  disarmed?: true
  /** `behind` only: the operator command, `gh pr update-branch <pr>`. */
  error?: string
}>
