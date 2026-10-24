import type { Facts, HookRecord, Report, Step } from './epic-types'

/**
 * Where the post-merge hook stands, for the next step and for the report alike.
 * This run's last record decides a failure first: failed, or started with no
 * result, is never run twice. Then any run's ok or skipped at the current base
 * commit counts as done. This run's own ok or skipped at another commit is
 * stale: the hook is not run again in this run. A later run still treats an
 * earlier ok at another commit as not done.
 */
export function hookStatus(facts: Pick<Facts, 'run' | 'baseSha' | 'hooks'>): {
  state: 'done' | 'failed' | 'pending' | 'stale'
  record: HookRecord | null
  detail: string
} {
  const ours = facts.hooks.filter((hook) => hook.run === facts.run).at(-1) ?? null
  if (ours?.result === 'failed') return { state: 'failed', record: ours, detail: 'the post-merge hook failed' }
  if (ours?.result === 'started') {
    return { state: 'failed', record: ours, detail: 'the post-merge hook started and left no result' }
  }
  const same =
    facts.hooks.find((hook) => hook.sha === facts.baseSha && (hook.result === 'ok' || hook.result === 'skipped')) ??
    null
  if (same) return { state: 'done', record: same, detail: `post-merge hook ${same.result} at ${facts.baseSha}` }
  if (ours && ours.sha !== facts.baseSha) {
    return {
      state: 'stale',
      record: ours,
      detail: `post-merge hook ${ours.result} at ${ours.sha}, not the current base ${facts.baseSha}`,
    }
  }
  return { state: 'pending', record: null, detail: 'post-merge hook not run' }
}

/**
 * Finalization only — the none-merged complete, and the hook decision after a
 * clean review. Not the ticket-start policy: there a dirty tree on the target's
 * own branch resumes, and a pending base proceeds.
 */
export function finalizationBlock(facts: Facts, report: Report): Step | null {
  if (!facts.tree.clean) {
    return {
      action: 'drop',
      stop: 'dirty-tree',
      reason: `the epic worktree is dirty on ${facts.tree.branch ?? 'a detached HEAD'} and the Epic run cannot complete`,
      report,
    }
  }
  if (facts.baseCi.state === 'red') {
    return {
      action: 'drop',
      stop: 'base-ci-red',
      reason: `base ${facts.base} is red: ${facts.baseCi.failed.join(', ')}`,
      report,
    }
  }
  if (facts.baseCi.state === 'pending') {
    return {
      action: 'drop',
      stop: 'base-ci-pending',
      reason: `base ${facts.base} is not green: ${facts.baseCi.pending.join(', ')}`,
      report,
    }
  }
  return null
}
