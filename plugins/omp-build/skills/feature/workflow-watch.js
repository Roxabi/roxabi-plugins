import { recordIntegrity } from '../../dist/contracts.js'
import {
  approves,
  behindMessage,
  enforceArmedGate,
  isCommitSha,
  readGate,
  readHeadRefOid,
  reviewBoundStopped,
} from './workflow-gate.js'
import { currentLandingMandate, evidenceText } from './workflow-mandate.js'
import { resolveLandingBase } from './workflow-readiness.js'
import { requiredReviewAdmission } from './workflow-records.js'
import { hasFreshReviewInput } from './workflow-review-input.js'
import { persistObservedCiStop } from './workflow-review-state.js'
import { errorText, gh, gitResult, stuckError } from './workflow-runtime.js'

function initialWatchResult(code, pr) {
  if (code === 0 || code === 4) return { status: 'stopped' }
  if (code === 1) return { status: 'ci-failed' }
  if (code === 2) return { status: 'ci-cancelled' }
  if (code === 3) return { status: 'ci-blocked' }
  if (code === 5) return { status: 'timeout' }
  if (code === 6) return { status: 'evaluate-only' }
  if (code === 7) return { status: 'behind', error: behindMessage(pr) }
  return { status: 'watch-failed', code }
}

function terminalState(code, gate, result) {
  if ((code === 7 || (code >= 0 && code <= 4)) && gate.state === 'MERGED') return { status: 'merged' }
  if ((code === 7 || (code >= 0 && code <= 4)) && gate.state === 'CLOSED') return { status: 'stopped' }
  return result
}

function reviewIntegrityRefusal(operations) {
  if (operations === null)
    return { reason: 'record-unreadable', detail: 'selected review attempt has no readable native operation' }
  for (const operation of operations) {
    if (operation.record === null)
      return { reason: 'record-unreadable', detail: 'selected review attempt has no readable native operation' }
    const refusal = recordIntegrity(operation.parts, operation.record)
    if (refusal !== null) return refusal
  }
  return null
}

async function currentContinuation(cwd, pr, records, operations, gate, result, ghFn, gitFn) {
  const head = await readHeadRefOid(cwd, pr, ghFn)
  const currentGate = { ...gate, headRefOid: head }
  const base = await resolveLandingBase(cwd, pr, ghFn, gitFn)
  if (base.refusal || !isCommitSha(head)) {
    return {
      policy: 'unarmed',
      gate: currentGate,
      result: { status: 'mandate-refused', reason: 'incomplete', error: 'current landing coordinates are incomplete' },
    }
  }
  const mandate = await currentLandingMandate(
    cwd,
    pr,
    ghFn,
    { head, base: base.name, baseTip: base.tip },
    gitFn ?? gitResult,
  )
  if (!mandate.admitted) {
    return {
      policy: 'unarmed',
      gate: currentGate,
      result: { status: 'mandate-refused', reason: mandate.reason, error: evidenceText(mandate.evidence) },
    }
  }
  const retaining = currentGate.state === 'OPEN' && (currentGate.autoMergeRequest || currentGate.authorization?.allowed)
  if (!retaining || reviewBoundStopped(records) || !approves(records.verdict) || !isCommitSha(records.head)) {
    return { policy: 'allow-approved', gate: currentGate, result }
  }
  const integrity = reviewIntegrityRefusal(operations)
  if (integrity !== null) return { policy: 'unarmed', gate: currentGate, result }
  const inputFresh = await hasFreshReviewInput(cwd, pr, records, { gh: ghFn, git: gitFn })
  const lastHead = await readHeadRefOid(cwd, pr, ghFn)
  const lastGate = { ...gate, headRefOid: lastHead }
  if (!inputFresh || lastHead !== records.head || lastHead !== head)
    return { policy: 'unarmed', gate: lastGate, result }
  const lastMandate = await currentLandingMandate(
    cwd,
    pr,
    ghFn,
    { head: lastHead, base: base.name, baseTip: base.tip },
    gitFn ?? gitResult,
  )
  const after = await readHeadRefOid(cwd, pr, ghFn)
  const finalGate = { ...gate, headRefOid: after }
  return !lastMandate.admitted || after !== lastHead
    ? { policy: 'unarmed', gate: finalGate, result }
    : { policy: 'allow-approved', gate: finalGate, result }
}

function watchPolicy(code) {
  return (code >= 0 && code <= 4) || code === 7 ? 'unarmed' : 'allow-approved'
}

function watchNeedsContinuation(result, policy, gate) {
  const continuation = result.status === 'timeout' || result.status === 'evaluate-only'
  const retaining =
    policy !== 'unarmed' && gate.state === 'OPEN' && (gate.autoMergeRequest || gate.authorization?.allowed)
  return { continuation, retaining }
}

async function readWatchExit(cwd, pr, code, ghFn, gitFn) {
  let gate, records, failure
  let policy = watchPolicy(code)
  let result = initialWatchResult(code, pr)
  try {
    gate = await readGate(cwd, pr, ghFn)
    result = terminalState(code, gate, result)
    const { continuation, retaining } = watchNeedsContinuation(result, policy, gate)
    if (continuation || retaining) {
      const review = await requiredReviewAdmission(cwd, pr, { gh: ghFn })
      records = review.records
      const resolved = await currentContinuation(cwd, pr, records, review.operations, gate, result, ghFn, gitFn)
      gate = resolved.gate ?? gate
      policy = resolved.policy
      if (continuation) result = resolved.result
    }
  } catch (error) {
    if (!error?.reviewRecords) failure = error
    policy = 'unarmed'
  }
  return { gate, records, failure, policy, result }
}

async function persistWatchCiStop(cwd, pr, code, watched, ghFn, gitFn) {
  if (watched.failure || code !== 1 || watched.result.status !== 'ci-failed' || watched.gate?.state !== 'OPEN') {
    return watched
  }
  try {
    await persistObservedCiStop(cwd, pr, { gh: ghFn, git: gitFn })
    return watched
  } catch (failure) {
    return { ...watched, failure }
  }
}

async function enforceWatchGate(cwd, pr, watched, ghFn) {
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, pr, {
      records: watched.records,
      gate: watched.gate,
      policy: watched.policy,
      gh: ghFn,
    })
  } catch (disarmError) {
    if (/merged while being disarmed/.test(errorText(disarmError))) return { status: 'merged' }
    throw watched.failure ? stuckError(disarmError, watched.failure) : disarmError
  }
  if (watched.failure) throw watched.failure
  return { ...watched.result, ...(receipt.disarmed && { disarmed: true }) }
}

export async function applyCiWatchExit(cwd, pr, code, { gh: ghFn = gh, git: gitFn } = {}) {
  const watched = await readWatchExit(cwd, pr, code, ghFn, gitFn)
  const result = await enforceWatchGate(cwd, pr, watched, ghFn)
  const persisted = await persistWatchCiStop(cwd, pr, code, watched, ghFn, gitFn)
  if (persisted.failure) throw persisted.failure
  return result
}
