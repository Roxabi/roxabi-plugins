import { finalizationBlock, hookStatus } from './epic-finalization'
import type { Facts, Report, Step } from './epic-types'

export function completionStep(facts: Facts, report: Report, postMergeReason: string | null): Step {
  const blocked = finalizationBlock(facts, report)
  if (blocked) return blocked

  const hook = hookStatus(facts)
  if (hook.state === 'failed') return { action: 'drop', stop: 'hook-failed', reason: hook.detail, report }
  if (hook.state === 'stale') return { action: 'drop', stop: 'hook-stale', reason: hook.detail, report }
  if (postMergeReason === null) return { action: 'complete', reason: 'every child closed and none merged', report }
  if (hook.state === 'done') return { action: 'complete', reason: hook.detail, report }
  return { action: 'post-merge', reason: postMergeReason, report }
}
