import type { ReviewActionBatch } from '../roxabi/uw-action-contract.ts'

export function admitsConfirmingReviewBatchItem(
  item: ReviewActionBatch['actions'][number],
  index: number,
  commonRequest: string,
  commonProjection: string,
  ids: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  const { taskName, assignedChunk, chunks } = item.projection
  const panel =
    assignedChunk === null
      ? chunks.length === 0 &&
        item.request.subject.kind === 'uw' &&
        item.request.subject.pullRequest === null &&
        taskName === `panel-context-${item.role}`
      : chunks.some((chunk) => chunk.index === assignedChunk) && taskName === `panel-${assignedChunk}-${item.role}`
  return (
    item.request.purpose === 'review' &&
    JSON.stringify({ ...item.request, actionId: '' }) === commonRequest &&
    JSON.stringify({ contextWindow: item.projection.contextWindow, chunks: item.projection.chunks }) ===
      commonProjection &&
    !ids.has(item.request.actionId) &&
    !names.has(item.projection.taskName) &&
    (index === 0 ? item.role === 'R-review-spec' : item.role !== 'R-review-spec' && panel)
  )
}
