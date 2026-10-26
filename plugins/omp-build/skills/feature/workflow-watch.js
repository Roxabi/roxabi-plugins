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
import { requiredReviewRecords } from './workflow-records.js'
import { hasFreshReviewInput } from './workflow-review-input.js'
import { persistObservedCiStop } from './workflow-review-state.js'
import { errorText, gh, gitResult, stuckError } from './workflow-runtime.js'

const SINCE_ATTEMPTS = 5
const SINCE_RETRY_MS = 200

export async function labeledReviewedAt(cwd, pr, ghFn = gh) {
  try {
    const { nameWithOwner } = JSON.parse(await ghFn(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    const [owner, repo] = (nameWithOwner || '').split('/')
    if (!owner || !repo) return ''
    const out = await ghFn(cwd, [
      'api',
      `repos/${owner}/${repo}/issues/${pr}/events`,
      '--paginate',
      '--jq',
      '.[] | select(.event == "labeled" and .label.name == "reviewed") | .created_at',
    ])
    const last = String(out).trim().split('\n').filter(Boolean).at(-1)
    const since = last?.replace(/\.\d+Z$/, 'Z') ?? ''
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since) ? since : ''
  } catch {
    return ''
  }
}

export async function waitLabeledSince(cwd, pr, ghFn, before, sleep) {
  for (let attempt = 0; attempt < SINCE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(SINCE_RETRY_MS)
    const since = await labeledReviewedAt(cwd, pr, ghFn)
    if (since && (before === '' || since > before)) return since
  }
  return ''
}

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
  if ((code === 7 || (code >= 0 && code <= 3)) && gate.state === 'MERGED') return { status: 'merged' }
  if ((code === 7 || (code >= 0 && code <= 3)) && gate.state === 'CLOSED') return { status: 'stopped' }
  return result
}

async function currentContinuation(cwd, pr, records, gate, result, ghFn, gitFn) {
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
  const retaining =
    currentGate.state === 'OPEN' &&
    (currentGate.autoMergeRequest || currentGate.labels.some((label) => label?.name === 'reviewed'))
  if (!retaining || reviewBoundStopped(records) || !approves(records.verdict) || !isCommitSha(records.head)) {
    return { policy: 'allow-approved', gate: currentGate, result }
  }
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
  return (code >= 1 && code <= 3) || code === 7 ? 'unarmed' : 'allow-approved'
}

function watchNeedsContinuation(result, policy, gate) {
  const continuation = result.status === 'timeout' || result.status === 'evaluate-only'
  const retaining =
    policy !== 'unarmed' &&
    gate.state === 'OPEN' &&
    (gate.autoMergeRequest || gate.labels.some((label) => label?.name === 'reviewed'))
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
      records = await requiredReviewRecords(cwd, pr, { gh: ghFn })
      const resolved = await currentContinuation(cwd, pr, records, gate, result, ghFn, gitFn)
      gate = resolved.gate ?? gate
      policy = resolved.policy
      if (continuation) result = resolved.result
    }
  } catch (error) {
    failure = error
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
  const persisted = await persistWatchCiStop(cwd, pr, code, watched, ghFn, gitFn)
  return enforceWatchGate(cwd, pr, persisted, ghFn)
}
