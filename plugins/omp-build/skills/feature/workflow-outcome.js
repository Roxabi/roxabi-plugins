function stop(reason, reenter, extra) {
  return { action: 'stop', claimMerged: false, reason, reenter, ...extra }
}

function blocked(status, reason) {
  return { action: 'blocked', claimMerged: false, reason, status }
}

function proofBlockedReentry(land) {
  const error = typeof land.error === 'string' ? land.error : ''
  if (error.includes('Produce it outside admission')) return 'acquire'
  if (error.includes('was revised after publication')) return 'acquire-then-review'
  if (
    [
      'not before approving review',
      'without a producer',
      'body that justifies',
      'has no review-input binding',
      'review-input binding is malformed',
      'is not the exact input that was reviewed',
      'applicability changed after review',
      're-review the head',
    ].some((fragment) => error.includes(fragment))
  )
    return 'same-head-review'
  if (
    [
      'obtain readable GitHub metadata',
      'no readable native comment identity',
      'unreadable native creation/revision facts',
    ].some((fragment) => error.includes(fragment))
  )
    return 'obtain-native-metadata'
  return 'after-named-cause'
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

function proofBlockedOutcome(land) {
  const reenter = proofBlockedReentry(land)
  return stop('proof-blocked', reenter, {
    bound: 'sticky',
    producer: land.producer ?? null,
    proofReason: land.reason ?? null,
    ...(reenter === 'same-head-review' ? { producerAtAdmission: false } : {}),
  })
}

const OUTCOMES = {
  watching: (land) =>
    typeof land.watch === 'string' && land.watch !== ''
      ? { action: 'start-watch', claimMerged: false, reportProof: true }
      : blocked('watching', 'watch-missing'),
  timeout: () => ({ action: 'reattach-watch', claimMerged: false }),
  'ci-failed': () => ({ action: 'next-review-step', ciFailed: true, claimMerged: false }),
  'not-approved': notApprovedOutcome,
  merged: () => ({ action: 'report-merged', claimMerged: true, offerTail: true }),
  'proof-blocked': proofBlockedOutcome,
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
