import type { Gh } from './review-base.ts'

export type DisarmReviewedBeforePushResult =
  | { disarmed: true }
  | { unarmed: true }
  | { closed: true }
  | { merged: true }
export declare function disarmReviewedBeforePush(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; push?: () => Promise<void> | void },
): Promise<DisarmReviewedBeforePushResult>
