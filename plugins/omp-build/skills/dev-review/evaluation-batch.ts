import type { FindingEvaluation, FindingEvidence, JudgmentBatch } from './evaluation-contract'
import { errorText, evaluateDrainedPair } from './evaluation-normalize'

type TerminalFailure = {
  reason: 'drain-failed' | 'status-failed'
  error: string
}

export interface BatchEvaluationOutcome {
  terminalFailure: TerminalFailure | null
  drainShapeFailure: boolean
}

interface BatchStatus {
  done: number
  running: boolean
}

type BatchAction = 'break' | 'continue' | 'invalid-drain-shape'

export async function drainBatch(
  batch: JudgmentBatch,
  evidenceById: Record<string, FindingEvidence>,
  result: Record<string, FindingEvaluation>,
): Promise<BatchEvaluationOutcome> {
  const outcome: BatchEvaluationOutcome = { terminalFailure: null, drainShapeFailure: false }
  let drained = 0

  while (true) {
    const rawPairs = await readPairs(batch, outcome)
    if (outcome.terminalFailure !== null) break
    if (!Array.isArray(rawPairs)) {
      outcome.drainShapeFailure = true
      break
    }

    drained += rawPairs.length
    if (recordPairs(rawPairs, evidenceById, result)) outcome.drainShapeFailure = true

    const rawStatus = await readStatus(batch, outcome)
    if (outcome.terminalFailure !== null) break

    const action = statusAction(rawStatus, drained, rawPairs, outcome)
    if (action === 'continue') continue
    if (action === 'invalid-drain-shape') outcome.drainShapeFailure = true
    break
  }

  return outcome
}

async function readPairs(batch: JudgmentBatch, outcome: BatchEvaluationOutcome): Promise<unknown> {
  try {
    return await batch.drain({ timeout: 30 })
  } catch (error) {
    outcome.terminalFailure = { reason: 'drain-failed', error: errorText(error) }
    return undefined
  }
}

function recordPairs(
  pairs: unknown[],
  evidenceById: Record<string, FindingEvidence>,
  result: Record<string, FindingEvaluation>,
): boolean {
  let invalidPair = false
  for (const pair of pairs) {
    const normalized = evaluateDrainedPair(pair)
    if (normalized === null) {
      invalidPair = true
      continue
    }
    if (Object.hasOwn(evidenceById, normalized.id)) result[normalized.id] = normalized.evaluation
  }
  return invalidPair
}

async function readStatus(batch: JudgmentBatch, outcome: BatchEvaluationOutcome): Promise<unknown> {
  try {
    return await batch.status()
  } catch (error) {
    outcome.terminalFailure = { reason: 'status-failed', error: errorText(error) }
    return undefined
  }
}

function statusAction(
  rawStatus: unknown,
  drained: number,
  pairs: unknown[],
  outcome: BatchEvaluationOutcome,
): BatchAction {
  if (rawStatus === null || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
    outcome.terminalFailure = { reason: 'status-failed', error: 'Judgment batch status is not an object' }
    return 'break'
  }

  const status = rawStatus as { done?: unknown; running?: unknown }
  if (!isBatchStatus(status)) {
    outcome.terminalFailure = { reason: 'status-failed', error: 'Judgment batch status has invalid completion fields' }
    return 'break'
  }
  if (status.running) return 'continue'
  if (drained < status.done && pairs.length > 0) return 'continue'
  return drained < status.done ? 'invalid-drain-shape' : 'break'
}

function isBatchStatus(candidate: { done?: unknown; running?: unknown }): candidate is BatchStatus {
  return (
    typeof candidate.running === 'boolean' &&
    typeof candidate.done === 'number' &&
    Number.isInteger(candidate.done) &&
    candidate.done >= 0
  )
}
