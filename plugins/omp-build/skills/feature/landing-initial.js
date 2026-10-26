import { recordIntegrity } from '../../dist/contracts.js'
import {
  bindLandingBase,
  landingBaseBlocked,
  landingExit,
  landingRefused,
  prepareInitialLanding,
  readLandingFields,
} from './landing-initial-preparation.js'
import { approves, behindMessage, isBehind, isCommitSha, readGate, reviewBoundStopped } from './workflow-gate.js'
import { currentLandingMandate, evidenceText } from './workflow-mandate.js'
import { resolveLandingBase } from './workflow-readiness.js'
import { requiredReviewAdmission } from './workflow-records.js'
import { validateLandingReviewInput } from './workflow-review-input.js'
import { errorText } from './workflow-runtime.js'

function reviewIntegrityRefusal(operation) {
  if (operation?.record === null || operation === null)
    return { reason: 'record-unreadable', detail: 'selected review record has no readable native operation' }
  return recordIntegrity(operation.parts, operation.record)
}

function refusedReviewIntegrity(records, operation, state) {
  const refusal = reviewIntegrityRefusal(operation)
  if (refusal === null) return null
  return {
    terminal: landingExit({ ...landingRefused(records, refusal.reason), error: refusal.detail }, { policy: 'unarmed' }),
    state,
  }
}
export function knownLandingGate(gate, armedAuto, armedLabel) {
  if (!gate) return gate
  return {
    ...gate,
    labels:
      armedLabel && !gate.labels.some((label) => label?.name === 'reviewed')
        ? [...gate.labels, { name: 'reviewed' }]
        : gate.labels,
    autoMergeRequest: armedAuto ? (gate.autoMergeRequest ?? { pinned: true }) : gate.autoMergeRequest,
  }
}

export async function readLandingCoordinates(cwd, pr, gh, git) {
  const base = await resolveLandingBase(cwd, pr, gh, git)
  const data = await readLandingFields(cwd, pr, gh, 'headRefOid,baseRefName')
  if (data.baseRefName === base.name) return { head: data.headRefOid, base }
  return {
    head: data.headRefOid,
    base: {
      name: data.baseRefName,
      refusal: {
        reason: 'unbound',
        error: 'the PR base changed during its repository-bound fetch; re-enter with the current base',
      },
    },
  }
}

export async function movedLanding(cwd, pr, gh, state, armedAuto, armedLabel, adapter) {
  let gate
  try {
    gate = await readGate(cwd, pr, gh)
  } catch {
    gate = knownLandingGate(state.gate, armedAuto, armedLabel)
  }
  return landingExit(landingRefused(state.records, 'head-moved'), {
    policy: 'unarmed',
    gate,
    adapter,
  })
}

export async function checkLandingCoordinates(cwd, pr, gh, git, state, armedAuto, armedLabel, adapter) {
  const current = await readLandingCoordinates(cwd, pr, gh, git)
  const blocked = await bindLandingBase(cwd, pr, gh, git, state, current.base)
  if (blocked) return blocked
  if (isCommitSha(current.head) && current.head === state.records.head) return null
  return movedLanding(cwd, pr, gh, state, armedAuto, armedLabel, adapter)
}

export async function refuseIfLandingMoved(cwd, pr, gh, git, state, armedAuto, armedLabel) {
  try {
    return await checkLandingCoordinates(cwd, pr, gh, git, state, armedAuto, armedLabel)
  } catch (readError) {
    return landingExit(landingRefused(state.records, 'head-moved'), { policy: 'unarmed', readError })
  }
}

export async function behindBeforeArm(cwd, pr, gh, state, armedAuto, armedLabel) {
  const fields = await readLandingFields(cwd, pr, gh, 'state,mergeStateStatus')
  if (!isBehind(fields)) return null
  let fresh
  try {
    fresh = await readGate(cwd, pr, gh)
  } catch {
    fresh = undefined
  }
  if (fresh === undefined) {
    return landingExit(
      { status: 'behind', error: behindMessage(pr) },
      { policy: 'unarmed', gate: knownLandingGate(state.gate, armedAuto, armedLabel) },
    )
  }
  if (!isBehind(fresh)) return null
  if (!isCommitSha(fresh.headRefOid) || fresh.headRefOid !== state.records.head) {
    return landingExit(landingRefused(state.records, 'head-moved'), { policy: 'unarmed', gate: fresh })
  }
  return landingExit({ status: 'behind', error: behindMessage(pr) }, { policy: 'unarmed', gate: fresh })
}

export async function checkBeforeArm(cwd, pr, gh, git, state, armedAuto, armedLabel, adapter) {
  const behind = await behindBeforeArm(cwd, pr, gh, state, armedAuto, armedLabel)
  if (behind) return behind
  return checkLandingCoordinates(cwd, pr, gh, git, state, armedAuto, armedLabel, adapter)
}

export async function validateLandingCandidate(cwd, pr, gh, git, state) {
  let current
  try {
    current = await resolveLandingBase(cwd, pr, gh, git)
  } catch (error) {
    return { terminal: landingBaseBlocked('unreadable', `PR base cannot be read: ${errorText(error)}`), state }
  }
  const changed = await bindLandingBase(cwd, pr, gh, git, state, current)
  if (changed) return { terminal: changed, state }
  const mandate = await currentLandingMandate(
    cwd,
    pr,
    gh,
    {
      head: state.records.head,
      base: state.landingBase,
      baseTip: state.landingContext.tip,
    },
    git,
  )
  if (!mandate.admitted) {
    return {
      terminal: landingExit(
        { status: 'mandate-refused', reason: mandate.reason, error: evidenceText(mandate.evidence) },
        { policy: 'unarmed' },
      ),
      state,
    }
  }
  const reviewInput = await validateLandingReviewInput(cwd, pr, state.records.head, state.records.input, { gh, git })
  if (!reviewInput.ok) {
    return {
      terminal: landingExit(
        { status: 'review-input-refused', reason: reviewInput.reason, error: reviewInput.error },
        { policy: 'unarmed' },
      ),
      state,
    }
  }
  return { state: { ...state, admitted: state.records.head } }
}

export async function refreshLandingAuthorization(cwd, pr, gh, git, state, retaining) {
  const review = await requiredReviewAdmission(cwd, pr, { gh })
  const { records, operation } = review
  const refreshed = { ...state, records }
  if (reviewBoundStopped(records)) {
    return { terminal: landingExit(landingRefused(records, 'review-bound'), { policy: 'unarmed' }), state: refreshed }
  }
  if (!approves(records.verdict)) {
    return { terminal: landingExit(landingRefused(records), { policy: 'unarmed' }), state: refreshed }
  }
  if (!isCommitSha(records.head)) {
    return { terminal: landingExit(landingRefused(records, 'review-unbound'), { policy: 'unarmed' }), state: refreshed }
  }
  const integrity = refusedReviewIntegrity(records, operation, refreshed)
  if (integrity !== null) return integrity
  if (retaining && state.admitted !== undefined && records.head !== state.admitted) {
    return { terminal: landingExit(landingRefused(records, 'head-moved'), { policy: 'unarmed' }), state: refreshed }
  }
  return validateLandingCandidate(cwd, pr, gh, git, refreshed)
}
function initialLandingRefusal(pr, records, gate, opening) {
  let reason = null
  if (reviewBoundStopped(records)) reason = 'review-bound'
  else if (!approves(records.verdict)) reason = undefined
  else if (!isCommitSha(records.head)) reason = 'review-unbound'
  else if (!isCommitSha(gate.headRefOid) || gate.headRefOid !== records.head) reason = 'head-moved'
  if (reason !== null) {
    return { terminal: landingExit(landingRefused(records, reason), { policy: 'unarmed' }), state: opening }
  }
  if (!isBehind(gate)) return null
  return {
    terminal: landingExit({ status: 'behind', error: behindMessage(pr) }, { policy: 'unarmed', gate }),
    state: opening,
  }
}

export async function readInitialLanding(cwd, pr, gh, git, landing, requiredContexts, owner) {
  const gate = await readGate(cwd, pr, gh)
  if (owner) owner.gate = gate
  const review = await requiredReviewAdmission(cwd, pr, { gh })
  const { records, operation } = review
  const opening = { records, gate }
  const refused = initialLandingRefusal(pr, records, gate, opening)
  if (refused) return refused
  const integrity = refusedReviewIntegrity(records, operation, opening)
  if (integrity !== null) return integrity
  const prepared = await prepareInitialLanding(cwd, pr, gh, git, landing, requiredContexts, opening)
  if (prepared.terminal) return prepared
  return {
    state: {
      ...opening,
      landingBase: prepared.landingContext.name,
      landingContext: prepared.landingContext,
      resolved: prepared.resolved,
      admitted: undefined,
      proof: undefined,
    },
  }
}
