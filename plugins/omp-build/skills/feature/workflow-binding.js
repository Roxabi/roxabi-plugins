const MANDATE_REASONS = new Set([
  'missing',
  'fix-only',
  'paused',
  'abandoned',
  'stale',
  'unsupported',
  'unconfirmed',
  'foreign',
  'ambiguous',
  'revoked',
  'material-spec',
  'config-drift',
  'unbound',
  'conflict',
  'incomplete',
  'incompatible-format',
  'unknown-binding',
  'incompatible',
  'unsafe',
  'materially-changed',
  'record-edited',
  'record-unreadable',
])

export function mandateReason(reason) {
  return typeof reason === 'string' && MANDATE_REASONS.has(reason) ? reason : 'unknown-binding'
}

export function bindingRefusalReason(reason) {
  if (reason === 'absent') return 'missing'
  if (reason === 'conflicting') return 'conflict'
  if (reason === 'partial' || reason === 'unconfirmed' || reason === 'incomplete') return 'incomplete'
  return mandateReason(reason)
}

export async function confirmSelectedBinding(cwd, pr, ghFn, claim = {}) {
  const admission = await import('../../roxabi/feature-admission.ts')
  if (typeof admission.confirmWorkflowBinding !== 'function') throw new Error('confirmWorkflowBinding is not exported')
  const confirmed = await admission.confirmWorkflowBinding({
    cwd,
    pr: Number(pr),
    issue: claim.issue,
    branch: claim.branch,
    base: claim.base,
    gh: ghFn,
  })
  if (confirmed?.ok !== true || typeof confirmed.recordId !== 'string' || confirmed.recordId === '') {
    return { ok: false, reason: typeof confirmed?.reason === 'string' ? confirmed.reason : 'unconfirmed' }
  }
  return { ok: true, recordId: confirmed.recordId }
}
