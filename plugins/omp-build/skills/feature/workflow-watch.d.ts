import type { Gh, Git } from './review-base.ts'

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

export declare function applyCiWatchExit(
  cwd: string,
  pr: number | string,
  code: number,
  options?: { gh?: Gh; git?: Git; mode?: string; stopPublication?: 'watch' | 'engine' },
): Promise<CiWatchExit>
