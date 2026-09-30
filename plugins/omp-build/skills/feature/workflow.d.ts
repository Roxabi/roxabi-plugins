/**
 * Declarations for the part of `workflow.js` a TypeScript module imports
 * (`epic-driver.ts`). Keep in step with the JSDoc in `workflow.js`.
 */

type Gh = (cwd: string, args: string[]) => Promise<string>

export declare const MAX_FIX_ROUNDS: 2

export declare function readLanding(cwd: string): {
  mode: 'native' | 'merge-on-green'
  required_checks: string[]
}

export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<{ disarmed: true }>

export declare function parseReviewRounds(text: string): { reviews: number; fixes: number; stopReason?: string } | null
