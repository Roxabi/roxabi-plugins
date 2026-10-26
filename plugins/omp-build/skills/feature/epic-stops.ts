// ── Stops ─────────────────────────────────────────────────────────────────────

/** Report, record a goal-stop marker, skip dependents, continue independents. */
export const TICKET_STOPS = [
  'review-bound',
  'review-input-refused',
  'base-blocked',
  'foreign-commit',
  'branch-mismatch',
  'no-scope',
  'timeout',
  'ci-cancelled',
  'ci-blocked',
  'stopped',
  'closed',
  'behind',
] as const

/** Disarm every in-flight PR and report the drop. */
export const SHARED_STOPS = [
  'base-ci-red',
  'base-ci-pending',
  'dirty-tree',
  'watch-failed',
  'bad-landing',
  'no-required-checks',
  'evaluate-only',
  'auto-merge-failed',
  'tracker-unresolvable',
  'hook-failed',
  'hook-stale',
  'final-review-blocking',
  'unknown-land-status',
  'driver-error',
] as const

/** A spent review bound stays stopped across runs; every other ticket stop is retried by a new run. */
export const STICKY_STOPS: readonly string[] = ['review-bound']

export type TicketStop = (typeof TICKET_STOPS)[number]
export type SharedStop = (typeof SHARED_STOPS)[number]

export function stopClass(reason: string): 'ticket' | 'shared' | 'no-progress' | null {
  if ((TICKET_STOPS as readonly string[]).includes(reason)) return 'ticket'
  if ((SHARED_STOPS as readonly string[]).includes(reason)) return 'shared'
  if (reason === 'no-progress') return 'no-progress'
  return null
}

/**
 * What a `landPr` / `applyCiWatchExit` status means under an Epic run. `timeout` is a
 * ticket stop, never a re-attach; `behind` is a retried ticket stop (the operator
 * updates the branch, a fresh run lands it). An unknown status fails closed as shared.
 */
export function landOutcome(
  status: string,
): { next: 'watch' | 'confirm' | 'reopen' } | { stop: TicketStop | SharedStop; class: 'ticket' | 'shared' } {
  switch (status) {
    case 'watching':
      return { next: 'watch' }
    case 'merged':
      return { next: 'confirm' }
    case 'ci-failed':
      return { next: 'reopen' }
    case 'timeout':
    case 'ci-cancelled':
    case 'ci-blocked':
    case 'stopped':
    case 'closed':
    case 'review-input-refused':
    case 'base-blocked':
    case 'behind':
      return { stop: status, class: 'ticket' }
    case 'watch-failed':
    case 'bad-landing':
    case 'no-required-checks':
    case 'evaluate-only':
    case 'auto-merge-failed':
      return { stop: status, class: 'shared' }
    default:
      return { stop: 'unknown-land-status', class: 'shared' }
  }
}
