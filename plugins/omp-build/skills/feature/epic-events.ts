import { RUN_ID } from './epic-naming'
import { isRecord } from './proof-base'

const SHA = /^[0-9a-f]{40}$/

export type EpicFixEvent = { event: 'epic-fix'; run: string }
export type GoalStopEvent = { event: 'goal-stop'; run: string; reason: string; detail?: string }
export type EpicReviewEvent = {
  event: 'epic-review'
  run: string
  range: string
  decisionId: string
  inventoryIds: string[]
}
export type PostMergeEvent = {
  event: 'post-merge'
  run: string
  result: 'started' | 'ok' | 'skipped' | 'failed'
  sha: string
  exitCode: number | null
}
export type GoalReportEvent = {
  event: 'goal-report'
  run: string
  outcome: 'complete' | 'drop'
  reason: string
  summary: unknown
  disarmed: unknown
  stillArmed: unknown
}
export type EpicEvent = EpicFixEvent | GoalStopEvent | EpicReviewEvent | PostMergeEvent | GoalReportEvent

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0)
  )
}

/** Validate the domain payload carried by one common `epic-event` record. */
export function parseEpicEvent(value: unknown): EpicEvent | null {
  if (!isRecord(value)) return null
  const run = validRun(value)
  if (!run) return null
  if (value.event === 'epic-fix') return { event: 'epic-fix', run }
  return goalStop(value, run) ?? epicReview(value, run) ?? postMerge(value, run) ?? goalReport(value, run)
}

function validRun(event: Record<string, unknown>): string | null {
  return typeof event.run === 'string' && RUN_ID.test(event.run) ? event.run : null
}

function goalStop(event: Record<string, unknown>, run: string): GoalStopEvent | null {
  if (event.event !== 'goal-stop' || typeof event.reason !== 'string' || event.reason.length === 0) return null
  if (typeof event.detail === 'string') return { event: 'goal-stop', run, reason: event.reason, detail: event.detail }
  return event.detail === undefined ? { event: 'goal-stop', run, reason: event.reason } : null
}

function epicReview(event: Record<string, unknown>, run: string): EpicReviewEvent | null {
  if (
    event.event !== 'epic-review' ||
    typeof event.range !== 'string' ||
    typeof event.decisionId !== 'string' ||
    event.decisionId.length === 0 ||
    !strings(event.inventoryIds)
  ) {
    return null
  }
  const [from, to, ...rest] = event.range.split('..')
  if (!from || !to || rest.length > 0 || !SHA.test(from) || !SHA.test(to)) return null
  return {
    event: 'epic-review',
    run,
    range: event.range,
    decisionId: event.decisionId,
    inventoryIds: event.inventoryIds,
  }
}

function postMerge(event: Record<string, unknown>, run: string): PostMergeEvent | null {
  if (
    event.event !== 'post-merge' ||
    typeof event.sha !== 'string' ||
    !SHA.test(event.sha) ||
    !postMergeResult(event.result) ||
    !validExitCode(event.exitCode)
  ) {
    return null
  }
  return { event: 'post-merge', run, result: event.result, sha: event.sha, exitCode: event.exitCode }
}

function postMergeResult(value: unknown): value is PostMergeEvent['result'] {
  return value === 'started' || value === 'ok' || value === 'skipped' || value === 'failed'
}

function validExitCode(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value))
}

function goalReport(event: Record<string, unknown>, run: string): GoalReportEvent | null {
  if (
    event.event !== 'goal-report' ||
    !goalReportOutcome(event.outcome) ||
    typeof event.reason !== 'string' ||
    !('summary' in event) ||
    !('disarmed' in event) ||
    !('stillArmed' in event)
  ) {
    return null
  }
  return {
    event: 'goal-report',
    run,
    outcome: event.outcome,
    reason: event.reason,
    summary: event.summary,
    disarmed: event.disarmed,
    stillArmed: event.stillArmed,
  }
}

function goalReportOutcome(value: unknown): value is GoalReportEvent['outcome'] {
  return value === 'complete' || value === 'drop'
}
