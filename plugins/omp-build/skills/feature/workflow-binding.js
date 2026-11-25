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
