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

/** The one reading of a PR's review records: counts, and the stop when the loop has stopped. */
export declare function interpretReviewHistory(
  comments: { body: string; author: { login: string } | null }[],
  options: { me: string; maxFixRounds?: number },
): { reviews: number; fixes: number; stopReason?: string }
