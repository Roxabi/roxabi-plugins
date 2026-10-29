import type { CanonicalRecord } from '../engine/record-schema.ts'
import { readReviewInputHistories } from '../roxabi/uw-input-readers.ts'
import { readReviewHistory } from '../skills/feature/workflow-records.js'
import { gh } from '../skills/feature/workflow-runtime.js'

type ReviewRecord = Extract<CanonicalRecord, { kind: 'review' }>

export async function history(cwd: string) {
  return readReviewHistory(cwd, 7)
}

export async function citedHistory(cwd: string, source: Awaited<ReturnType<typeof history>>) {
  const cited = await readReviewInputHistories(source, { cwd, gh })
  if (!cited.ok) throw new Error(`review-cited-history-unreadable:${JSON.stringify(cited.diagnostics)}`)
  return cited.value
}

export function reviewRecord(record: CanonicalRecord): record is ReviewRecord {
  return record.kind === 'review'
}
