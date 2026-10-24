import type { Gh, Git } from './proof-base.ts'

export type CiWatchStatus =
  | 'stopped'
  | 'ci-failed'
  | 'ci-cancelled'
  | 'ci-blocked'
  | 'timeout'
  | 'evaluate-only'
  | 'behind'
  | 'watch-failed'
  | 'merged'
  | 'mandate-refused'
export type CiWatchExit = {
  status: CiWatchStatus
  code?: number
  error?: string
  reason?: string
  disarmed?: true
}

export declare function labeledReviewedAt(cwd: string, pr: number | string, ghFn?: Gh): Promise<string>
export declare function waitLabeledSince(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  before: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string>
export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  options?: { gh?: Gh; git?: Git; mode?: string },
): Promise<CiWatchExit>
