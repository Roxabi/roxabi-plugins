export function snapshot(
  state = 'OPEN',
  options: { autoMergeRequest?: unknown; extraChecks?: unknown[] } = {},
): string {
  return JSON.stringify({
    state,
    mergeStateStatus: state === 'OPEN' ? 'BLOCKED' : 'UNKNOWN',
    autoMergeRequest: options.autoMergeRequest ?? null,
    labels: state === 'OPEN' ? [{ name: 'reviewed' }] : [],
    headRefOid: 'a'.repeat(40),
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }, ...(options.extraChecks ?? [])],
  })
}
