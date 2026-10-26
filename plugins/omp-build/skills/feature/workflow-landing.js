import { armMergeOnGreen, armNative } from './landing-arm.js'
import { finishLanding } from './landing-finish.js'
import { readInitialLanding, validateLandingCandidate } from './landing-initial.js'
import { landingExit } from './landing-initial-preparation.js'
import { resolveReviewPr } from './workflow-pr.js'
import { ciWatchSh, gh, gitResult, shellQuote } from './workflow-runtime.js'

function watchingTerminal(pr, state, since) {
  const sinceArg = since ? ` --since ${since}` : ''
  return landingExit({
    status: 'watching',
    mode: state.resolved.mode,
    watch: `bash ${shellQuote(ciWatchSh())} ${shellQuote(String(pr))} --merge-mode ${state.resolved.mode} --base ${shellQuote(state.landingBase)}${sinceArg}`,
    proof: state.proof,
  })
}

async function initializeLanding(cwd, pr, ghFn, gitFn, landing, requiredContexts, resources) {
  const number = await resolveReviewPr(cwd, pr, { gh: ghFn })
  if (number === null) return { number, terminal: landingExit({ status: 'no-pr' }, { refresh: false }) }
  const initial = await readInitialLanding(cwd, number, ghFn, gitFn, landing, requiredContexts, resources)
  return { number, terminal: initial.terminal, state: initial.state }
}

async function armLanding(cwd, pr, ghFn, gitFn, sleep, state, armedAuto, armedLabel, resources) {
  const armed =
    state.resolved.mode === 'merge-on-green'
      ? await armMergeOnGreen(cwd, pr, ghFn, gitFn, sleep, state, armedAuto, armedLabel, resources)
      : await armNative(cwd, pr, ghFn, gitFn, state, armedAuto, armedLabel, resources)
  const nextArmedAuto = resources.armedAuto || armed.armedAuto || armedAuto
  const nextArmedLabel = resources.armedLabel || armed.armedLabel || armedLabel
  resources.armedAuto = nextArmedAuto
  resources.armedLabel = nextArmedLabel
  return {
    terminal: armed.terminal,
    state: armed.state ?? state,
    armedAuto: nextArmedAuto,
    armedLabel: nextArmedLabel,
    since: armed.since ?? '',
  }
}

export async function landPr(
  cwd,
  pr,
  {
    gh: ghFn = gh,
    git: gitFn = gitResult,
    requiredContexts,
    landing,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const resources = { gate: undefined, armedAuto: false, armedLabel: false }
  let terminal
  let state
  let armedAuto = false
  let armedLabel = false
  try {
    const initial = await initializeLanding(cwd, pr, ghFn, gitFn, landing, requiredContexts, resources)
    pr = initial.number
    terminal = initial.terminal
    state = initial.state
    if (!terminal && state) {
      const admitted = await validateLandingCandidate(cwd, pr, ghFn, gitFn, state)
      terminal = admitted.terminal
      state = admitted.state ?? state
    }
    if (!terminal && state) {
      const armed = await armLanding(cwd, pr, ghFn, gitFn, sleep, state, armedAuto, armedLabel, resources)
      terminal = armed.terminal
      state = armed.state
      armedAuto = armed.armedAuto
      armedLabel = armed.armedLabel
      if (!terminal) terminal = watchingTerminal(pr, state, armed.since)
    }
  } catch (failure) {
    terminal = landingExit(undefined, { policy: 'unarmed', failure })
  }
  return finishLanding(cwd, pr, ghFn, gitFn, terminal, state, armedAuto, armedLabel, resources)
}
