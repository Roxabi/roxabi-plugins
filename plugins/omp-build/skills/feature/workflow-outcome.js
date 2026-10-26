function stop(reason, reenter, extra) {
  return { action: 'stop', claimMerged: false, reason, reenter, ...extra }
}

function blocked(status, reason) {
  return { action: 'blocked', claimMerged: false, reason, status }
}

function reviewInputRefusedOutcome() {
  return stop('review-input-refused', 'same-head-review', { bound: 'sticky' })
}

function baseBlockedOutcome() {
  return stop('base-blocked', 'after-named-cause', { bound: 'sticky' })
}

function notApprovedOutcome(land) {
  if (land.reason === 'review-bound') return stop('review-bound', 'none', { reviewAgain: false })
  if (land.reason === 'head-moved')
    return { action: 'next-review-step', ciFailed: false, claimMerged: false, reason: 'head-moved' }
  if (land.reason === 'review-unbound')
    return stop('review-unbound', 'review-when-head-readable', { reviewAgain: false })
  return {
    action: 'review-if-unspent',
    claimMerged: false,
    reason: typeof land.reason === 'string' ? land.reason : 'not-approved',
  }
}

const OUTCOMES = {
  watching: (land) =>
    typeof land.watch === 'string' && land.watch !== ''
      ? { action: 'start-watch', claimMerged: false }
      : blocked('watching', 'watch-missing'),
  timeout: () => ({ action: 'reattach-watch', claimMerged: false }),
  'ci-failed': () => ({ action: 'next-review-step', ciFailed: true, claimMerged: false }),
  'not-approved': notApprovedOutcome,
  merged: () => ({ action: 'report-merged', claimMerged: true, offerTail: true }),
  'review-input-refused': reviewInputRefusedOutcome,
  'base-blocked': baseBlockedOutcome,
  'ci-cancelled': () => stop('ci-cancelled', 'rerun-ci-then-land'),
  'ci-blocked': () => stop('ci-blocked', 'resolve-checks-then-land'),
  behind: () => stop('behind', 'update-branch-then-land', { startWatch: false, updateBranchFromCycle: false }),
  'watch-failed': () => stop('watch-failed', 'none', { retainArm: 'current-authorization-only' }),
  'evaluate-only': () =>
    stop('evaluate-only', 'manual-merge', {
      wait: false,
      report: 'evaluate-only — manual merge required',
      doc: 'docs/kit/ci-app-setup.md',
      retainArm: 'current-authorization-only',
    }),
  'bad-landing': () => stop('bad-landing', 'fix-landing-config-then-land'),
  'no-required-checks': () => stop('no-required-checks', 'resolve-check-enforcement-then-land'),
  stopped: () => stop('stopped', 'none'),
  closed: () => stop('closed', 'none'),
  'auto-merge-failed': (land) =>
    stop('auto-merge-failed', land.armed === true ? 'clear-remainder-by-hand' : 'none', { armed: land.armed === true }),
  'no-pr': () => stop('no-pr', 'none'),
  'mandate-refused': (land) =>
    stop('mandate-refused', 'none', {
      reviewAgain: false,
      mandateReason: typeof land.reason === 'string' ? land.reason : 'unknown-binding',
    }),
}

export function featureLandOutcome(land) {
  const status = typeof land?.status === 'string' ? land.status : ''
  const outcome = Object.hasOwn(OUTCOMES, status) ? OUTCOMES[status] : undefined
  return outcome ? outcome(land) : blocked(status, 'unknown-land-status')
}
