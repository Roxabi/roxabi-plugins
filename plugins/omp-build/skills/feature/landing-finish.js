import { knownLandingGate, readLandingCoordinates, refreshLandingAuthorization } from './landing-initial.js'
import { bindLandingBase, landingRefused, mergedAuthorized } from './landing-initial-preparation.js'
import { enforceArmedGate, mayStayArmed, readGate } from './workflow-gate.js'
import { errorText, stuckError } from './workflow-runtime.js'

function watchingWithProof(terminal, proof) {
  if (terminal.result?.status !== 'watching') return terminal
  return { ...terminal, result: { ...terminal.result, proof } }
}

async function settledMerge(cwd, pr, gh, git, terminal, state, refreshFailed) {
  if (refreshFailed || terminal.readError !== undefined) return false
  if (terminal.result?.status !== 'watching' || state.admitted === undefined) return false
  if (state.landingContext === undefined) return false
  return mergedAuthorized(cwd, pr, gh, git, state.landingContext.tip, state.admitted)
}

function disarmUnauthorizedTerminal(terminal, authorization) {
  if (!authorization) return terminal
  return {
    ...terminal,
    policy: 'unarmed',
    ...(!terminal.failure && { result: authorization.result }),
  }
}

function disarmStaleTerminal(terminal, state, gate) {
  if (
    mayStayArmed(state.records, gate, false) &&
    (state.admitted === undefined || gate.headRefOid === state.admitted)
  ) {
    return terminal
  }
  const next = { ...terminal, policy: 'unarmed' }
  return !next.failure && next.result?.status === 'watching'
    ? { ...next, result: landingRefused(state.records, 'head-moved') }
    : next
}

async function refreshFinalTerminal(cwd, pr, gh, git, terminal, state, seen) {
  if (seen?.state !== 'OPEN' || terminal.policy === 'unarmed' || !terminal.refresh) {
    return { terminal, state, seen, refreshFailed: false }
  }
  try {
    const refreshed = await refreshLandingAuthorization(cwd, pr, gh, git, state, true)
    const current = await readLandingCoordinates(cwd, pr, gh, git)
    const gate = { ...seen, headRefOid: current.head }
    const authorization = refreshed.terminal ?? (await bindLandingBase(cwd, pr, gh, git, state, current.base))
    const currentState = refreshed.state ?? state
    const authorized = disarmUnauthorizedTerminal(terminal, authorization)
    return {
      terminal: watchingWithProof(disarmStaleTerminal(authorized, currentState, gate), currentState.proof),
      state: currentState,
      seen: gate,
      refreshFailed: false,
    }
  } catch (failure) {
    const concrete = failure === undefined ? new Error('epilogue refresh failed without an error value') : failure
    return {
      terminal: {
        ...terminal,
        policy: 'unarmed',
        ...(terminal.failure === undefined && { failure: concrete }),
      },
      state,
      seen,
      refreshFailed: true,
    }
  }
}

async function mergedDisarmOutcome(cwd, pr, gh, git, terminal, state, refreshFailed) {
  if (terminal.result?.status === 'behind') return { status: 'merged' }
  if (!(await settledMerge(cwd, pr, gh, git, terminal, state, refreshFailed))) return null
  return { ...terminal.result, ...(state.proof !== undefined && { proof: state.proof }) }
}

async function disabledAutoOutcome(cwd, pr, gh, terminal) {
  if (terminal.receipt.disarmed) {
    return {
      status: 'auto-merge-failed',
      armed: false,
      error: terminal.readError
        ? `head unreadable after --disable-auto failed; the gate was disarmed — ${errorText(terminal.readError)}`
        : 'head moved after --disable-auto failed; the gate was disarmed',
    }
  }
  try {
    const gate = await readGate(cwd, pr, gh)
    const names = []
    if (gate.autoMergeRequest) names.push('auto-merge')
    if (gate.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
    if (names.length) {
      return {
        status: 'auto-merge-failed',
        armed: true,
        error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(terminal.disableError)})`,
      }
    }
    const head = terminal.readError ? `the head could not be read — ${errorText(terminal.readError)}` : 'the head moved'
    return {
      status: 'auto-merge-failed',
      armed: false,
      error: `PR ${pr} is ${gate.state} with nothing armed after --disable-auto failed; ${head}`,
    }
  } catch (error) {
    return {
      status: 'auto-merge-failed',
      armed: true,
      error: `PR ${pr} could not be read back; auto-merge and reviewed may stay armed — ${errorText(error)}`,
    }
  }
}

async function disarmFailureOutcome(cwd, pr, gh, git, terminal, state, refreshFailed, disarmError) {
  if (/merged while being disarmed/.test(errorText(disarmError))) {
    const outcome = await mergedDisarmOutcome(cwd, pr, gh, git, terminal, state, refreshFailed)
    if (outcome) return outcome
  }
  const error = stuckError(disarmError, terminal.failure ?? terminal.readError)
  if (terminal.adapter) return { status: 'auto-merge-failed', armed: true, error: error.message }
  throw error
}

export async function finishLanding(cwd, pr, gh, git, terminal, state, armedAuto, armedLabel, owner) {
  const known = knownLandingGate(
    owner?.gate ?? state?.gate,
    owner?.armedAuto ?? armedAuto,
    owner?.armedLabel ?? armedLabel,
  )
  const refreshed = await refreshFinalTerminal(cwd, pr, gh, git, terminal, state, terminal.gate ?? known)
  const finalTerminal = refreshed.terminal
  let receipt
  try {
    receipt = await enforceArmedGate(cwd, pr, {
      records: refreshed.state?.records,
      gate: refreshed.seen,
      policy: finalTerminal.policy,
      gh,
    })
  } catch (disarmError) {
    return disarmFailureOutcome(cwd, pr, gh, git, finalTerminal, refreshed.state, refreshed.refreshFailed, disarmError)
  }
  const received = { ...finalTerminal, receipt }
  if (received.failure) throw received.failure
  if (received.adapter === 'disable') return disabledAutoOutcome(cwd, pr, gh, received)
  return { ...received.result, ...(receipt.disarmed && { disarmed: true }) }
}
