import { buildRecord, deriveReviewState, publishGitHubRecord } from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy'
import {
  approves,
  enforceArmedGate,
  isCommitSha,
  readGate,
  readHeadRefOid,
  reviewBoundStopped,
} from './workflow-gate.js'
import { resolveReviewPr } from './workflow-pr.js'
import { resolveLandingBase } from './workflow-readiness.js'
import {
  readReviewHistory,
  requiredReviewRecords,
  reviewRecords,
  reviewRefusal,
  reviewTaxonomy,
} from './workflow-records.js'
import { hasFreshReviewInput } from './workflow-review-input.js'
import { errorText, gh } from './workflow-runtime.js'

export const MAX_FIX_ROUNDS = 2
const STOP_GUIDANCE =
  'Use the canonical operator-supervised recovery procedure (skills/dev-review/recovery.md). This PR remains stopped and disarmed; preserve its antecedent, findings and consumed rounds. A successor begins only after the operator approves the dossier, revised scope/plan and concrete checkpoint; it then requires fresh independent review, proof, CI and normal landing admission. No extra review on this PR or manual merge bypass.'

function stopStep(reason, reviews) {
  const why =
    reason === 'ci-failed'
      ? `A required check failed on the head review ${reviews} approved, and no fix is left.`
      : `Review bound reached: ${reviews} reviews and the latest after the bound does not approve.`
  return { action: 'stop', reason, reviews, message: `${why} ${STOP_GUIDANCE}` }
}

function fixStep(reviews, reason) {
  return { action: 'fix', reviews, remaining: MAX_FIX_ROUNDS - reviews, ...(reason ? { reason } : {}) }
}

export function reviewStep(records, { head, ciFailed = false }) {
  const { reviews } = records
  if (reviewBoundStopped(records)) return stopStep('review-bound', reviews)
  const current = isCommitSha(head) && records.head === head
  if (ciFailed) {
    if (!current || !approves(records.verdict))
      throw new Error('nextReviewStep: a ci-failed fix needs the latest review record to approve the current head')
    return reviews <= MAX_FIX_ROUNDS ? fixStep(reviews, 'ci-failed') : stopStep('ci-failed', reviews)
  }
  if (reviews === 0) return { action: 'review', reason: 'no-review', reviews }
  if (!current) return { action: 'review', reason: 'head-moved', reviews }
  if (approves(records.verdict)) return { action: 'land', reviews }
  if (records.verdict === 'Request changes') return fixStep(reviews)
  return { action: 'review', reason: 'no-verdict', reviews }
}

export async function persistObservedCiStop(cwd, pr, { gh: ghFn = gh } = {}) {
  const history = await readReviewHistory(cwd, pr, ghFn)
  const summary = reviewRecords(history)
  if (!summary.ok) throw reviewRefusal(summary)
  const gate = await readGate(cwd, pr, ghFn)
  if (!isCommitSha(gate.headRefOid) || summary.value.head !== gate.headRefOid || !approves(summary.value.verdict))
    throw new Error('required CI stop is no longer bound to a current approving review')
  const state = deriveReviewState(
    history,
    {
      ...history.source.scope,
      candidateGitSHA: gate.headRefOid,
      input: summary.value.input,
      ci: 'red',
      acceptedEvidencePolicyRef: null,
    },
    reviewTaxonomy(),
  )
  if (!state.ok) throw reviewRefusal(state)
  if (state.requiredStop === null || state.requiredStop.reason !== 'ci-failed') return false
  const confirmed = history.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'stop' &&
      operation.record.payload.reason === state.requiredStop.reason &&
      operation.record.payload.reviewId === state.requiredStop.reviewId,
  )
  if (confirmed !== undefined) return true
  const built = buildRecord({
    ...history.source.scope,
    version: 1,
    recordId: `review-stop-${state.requiredStop.reviewId}`,
    runId: 'normal-workflow',
    operationId: `review-stop-${state.requiredStop.reviewId}`,
    kind: 'stop',
    payload: state.requiredStop,
  })
  if (!built.ok) throw reviewRefusal(built)
  const published = await publishGitHubRecord(built.value, history, withRoxabiGitHubPolicy({ cwd, gh: ghFn }), null)
  if (published.status !== 'confirmed') throw reviewRefusal(published)
  return true
}

async function stableArmReview(cwd, number, records, gate, ciFailed, ghFn, gitFn) {
  const base = await resolveLandingBase(cwd, number, ghFn, gitFn)
  if (base.refusal) return { policy: 'unarmed' }
  const inputFresh = await hasFreshReviewInput(cwd, number, records, { gh: ghFn, git: gitFn })
  const lastHead = await readHeadRefOid(cwd, number, ghFn)
  const currentGate = { ...gate, headRefOid: lastHead }
  if (!inputFresh || lastHead !== records.head) {
    return {
      policy: 'unarmed',
      gate: currentGate,
      step: {
        action: 'review',
        reason: lastHead !== records.head ? 'head-moved' : 'review-input-changed',
        reviews: records.reviews,
      },
    }
  }
  const step = reviewStep(records, { head: currentGate.headRefOid, ciFailed })
  return { policy: step.action === 'land' ? 'allow-approved' : 'unarmed', gate: currentGate, step }
}

async function selectReviewStep(cwd, pr, ciFailed, ghFn) {
  let number = pr,
    records,
    gate,
    step,
    failure,
    policy = 'allow-approved'
  try {
    if (pr === null || pr === undefined || pr === '')
      throw new TypeError(`nextReviewStep: pr is required, got ${JSON.stringify(pr)}`)
    number = await resolveReviewPr(cwd, pr, { gh: ghFn })
    gate = await readGate(cwd, number, ghFn)
    records = await requiredReviewRecords(cwd, number, { gh: ghFn })
    step = reviewStep(records, { head: gate.headRefOid, ciFailed })
    if (step.action !== 'land') policy = 'unarmed'
  } catch (error) {
    const refusal = error?.reviewRecords
    if (refusal?.spent === true) {
      try {
        gate = await readGate(cwd, number, ghFn)
        step = stopStep('review-bound', refusal.knownReviews)
        policy = 'unarmed'
      } catch (gateError) {
        failure = gateError
      }
    } else {
      failure = error
      policy = 'unarmed'
    }
  }
  return { number, records, gate, step, failure, policy }
}

async function refreshApprovedReviewArm(cwd, selected, ciFailed, reviewing, ghFn, gitFn) {
  if (!selected.records || selected.gate?.state !== 'OPEN' || selected.policy === 'unarmed' || reviewing) {
    return selected
  }
  try {
    const records = await requiredReviewRecords(cwd, selected.number, { gh: ghFn })
    const result = await stableArmReview(cwd, selected.number, records, selected.gate, ciFailed, ghFn, gitFn)
    return {
      ...selected,
      records,
      gate: result.gate ?? selected.gate,
      policy: result.policy,
      ...(!selected.failure && result.step && { step: result.step }),
    }
  } catch (error) {
    return { ...selected, failure: selected.failure ?? error, policy: 'unarmed' }
  }
}

async function persistSelectedCiStop(cwd, selected, ciFailed, ghFn, gitFn) {
  if (selected.failure || !ciFailed || selected.step?.action !== 'stop' || selected.step.reason !== 'ci-failed') {
    return selected
  }
  try {
    await persistObservedCiStop(cwd, selected.number, { gh: ghFn, git: gitFn })
    return selected
  } catch (error) {
    return { ...selected, failure: error }
  }
}

async function enforceSelectedReviewGate(cwd, selected, reviewing, ghFn) {
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, selected.number, {
      records: selected.records,
      gate: selected.gate,
      reviewing,
      policy: selected.policy,
      gh: ghFn,
    })
  } catch (disarmError) {
    if (selected.failure) {
      throw new Error(`${errorText(selected.failure)} — and the disarm failed: ${errorText(disarmError)}`, {
        cause: selected.failure,
      })
    }
    throw disarmError
  }
  if (selected.failure) throw selected.failure
  return { ...selected.step, ...(receipt.disarmed && { disarmed: true }) }
}

export async function nextReviewStep(cwd, pr, { ciFailed = false, reviewing = false, gh: ghFn = gh, git: gitFn } = {}) {
  const selected = await selectReviewStep(cwd, pr, ciFailed, ghFn)
  const refreshed = await refreshApprovedReviewArm(cwd, selected, ciFailed, reviewing, ghFn, gitFn)
  const persisted = await persistSelectedCiStop(cwd, refreshed, ciFailed, ghFn, gitFn)
  return enforceSelectedReviewGate(cwd, persisted, reviewing, ghFn)
}
