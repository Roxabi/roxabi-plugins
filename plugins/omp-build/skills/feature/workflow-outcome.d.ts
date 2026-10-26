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
  | 'same-head-review'
  | 'after-named-cause'

export type FeatureLandOutcome =
  | { action: 'start-watch'; claimMerged: false }
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

export type LandingStatus = {
  status?: string
  reason?: string
  error?: string
  code?: number
  armed?: boolean
  watch?: string
}
/** Non-Epic map of a landPr/applyCiWatchExit status. Unknown status is blocked. */
export declare function featureLandOutcome(land: LandingStatus): FeatureLandOutcome
