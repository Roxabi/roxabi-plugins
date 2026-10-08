/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

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

/**
 * Own marked reviews by `me` (#710). `reviews` counts exact `Request changes`
 * only; approvals neither spend nor reset. `verdict` and `head` are the latest
 * marked review. `spent` sticks once a third `Request changes` is seen.
 */
export declare function reviewRecords(
  comments: { body: string; author: { login: string } | null }[],
  options: { me: string },
): { reviews: number; verdict: string | null; head: string | null; spent: boolean }

export declare function openPr(
  cwd: string,
  input: { issue: number; branch: string; base: string; title: string; body?: string },
): Promise<{ number: number; status: 'created' | 'existing' }>

export declare function landPr(
  cwd: string,
  pr: number | string,
): Promise<{
  status: string
  mode?: string
  watch?: string
  reason?: string
  /** Only `true`, only when a read-back confirmed the disarm; never a no-op claim. */
  disarmed?: true
  /** `auto-merge-failed` only: `false` after a confirmed clear or a refused pin (not a clear claim), `true` when something stays armed. */
  armed?: boolean
  /** The reason for `bad-landing` or `watch-failed`; for `auto-merge-failed`, what stays armed or why the gate was disarmed. Only two fragments are contract: the remaining arms follow `stays armed — <arms>`, and unconfirmed state is named by `could not be read back`. The prefix and causal prose around them are not a stable API. */
  error?: string
}>

export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  opts?: { mode?: string },
): Promise<{ status: string; disarmed?: true }>
