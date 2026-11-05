import type { ReviewActionBatch } from '../roxabi/uw-action-contract.ts'

export function admitsConfirmingReviewBatchItem(
  item: ReviewActionBatch['actions'][number],
  index: number,
  commonRequest: string,
  commonProjection: string,
  ids: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  const panel = /^panel-(\d+)-(.+)$/.exec(item.projection.taskName)
  return (
    item.request.purpose === 'review' &&
    JSON.stringify({ ...item.request, actionId: '' }) === commonRequest &&
    JSON.stringify({ contextWindow: item.projection.contextWindow, chunks: item.projection.chunks }) ===
      commonProjection &&
    !ids.has(item.request.actionId) &&
    !names.has(item.projection.taskName) &&
    (index === 0 || (panel !== null && Number(panel[1]) === item.projection.assignedChunk))
  )
}
