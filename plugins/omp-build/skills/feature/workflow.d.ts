/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

type Gh = (cwd: string, args: string[]) => Promise<string>

export declare function readLanding(cwd: string): {
  mode: 'native' | 'merge-on-green'
  required_checks: string[]
}

export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<{ disarmed: true }>

/** The review records by `me` (#710): count, latest verdict and head, and whether the bound is spent. */
export declare function reviewRecords(
  comments: { body: string; author: { login: string } | null }[],
  options: { me: string },
): { reviews: number; verdict: string | null; head: string | null; spent: boolean }

/** `proof-blocked`: the proof gate applies to this repository and refused (nothing was written). */
export declare function openPr(
  cwd: string,
  input: { issue: number; branch: string; base: string; title: string; body?: string; proof?: unknown },
  deps?: { gh?: Gh; git?: Gh },
): Promise<{ number: number; status: 'created' | 'existing' } | { status: 'proof-blocked'; reason: string }>

export declare function landPr(
  cwd: string,
  pr: number | string,
  opts?: {
    gh?: Gh
    git?: Gh
    proof?: unknown
    requiredContexts?: string[]
    landing?: { mode: string; required_checks: string[] }
    sleep?: (ms: number) => Promise<void>
  },
): Promise<
  | { status: 'proof-blocked'; reason: string; disarmed?: true }
  | { status: string; mode?: string; watch?: string; reason?: string; disarmed?: true }
>

export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  opts?: { mode?: string },
): Promise<{ status: string }>
