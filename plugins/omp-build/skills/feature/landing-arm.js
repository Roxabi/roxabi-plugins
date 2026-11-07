import { randomUUID } from 'node:crypto'
import authorization from './head-authorization.cjs'

import {
  checkBeforeArm,
  checkLandingCoordinates,
  knownLandingGate,
  readLandingCoordinates,
  refreshLandingAuthorization,
  refuseIfLandingMoved,
} from './landing-initial.js'
import { bindLandingBase, landingExit } from './landing-initial-preparation.js'
import { errorText } from './workflow-runtime.js'

async function refreshAndCheck(cwd, pr, gh, git, state, armedAuto, armedLabel) {
  const refreshed = await refreshLandingAuthorization(cwd, pr, gh, git, state, false)
  if (refreshed.terminal) return refreshed
  const terminal = await checkBeforeArm(cwd, pr, gh, git, refreshed.state, armedAuto, armedLabel)
  return terminal ? { terminal } : refreshed
}

async function writeLandingLabel(cwd, pr, gh, git, state, armedAuto, armedLabel, args, arm, owner) {
  const nextLabel = arm || armedLabel
  if (arm && owner) owner.armedLabel = true
  try {
    await gh(cwd, args)
  } catch (failure) {
    const terminal = await refuseIfLandingMoved(cwd, pr, gh, git, state, armedAuto, nextLabel)
    return { armedLabel: nextLabel, terminal: terminal ?? landingExit(undefined, { failure }) }
  }
  return { armedLabel: nextLabel }
}

async function refusedNativePin(cwd, pr, gh, git, state, armedAuto, armedLabel) {
  try {
    const terminal = await checkLandingCoordinates(cwd, pr, gh, git, state, armedAuto, armedLabel)
    if (terminal) return terminal
  } catch (failure) {
    return landingExit(undefined, { policy: 'unarmed', failure })
  }
  return landingExit({ status: 'auto-merge-failed', armed: false })
}

async function afterNativeWrite(cwd, pr, gh, git, state, armedAuto, armedLabel) {
  try {
    const refreshed = await refreshLandingAuthorization(cwd, pr, gh, git, state, true)
    if (refreshed.terminal) {
      return { ...refreshed, terminal: { ...refreshed.terminal, adapter: 'native' } }
    }
    const terminal = await checkLandingCoordinates(cwd, pr, gh, git, refreshed.state, armedAuto, armedLabel, 'native')
    return terminal ? { terminal } : refreshed
  } catch (failure) {
    return { terminal: landingExit(undefined, { policy: 'unarmed', failure, adapter: 'native' }) }
  }
}

async function repinExisting(cwd, pr, gh, git, state, armedAuto, armedLabel, pin) {
  try {
    await gh(cwd, ['pr', 'merge', String(pr), '--disable-auto'])
  } catch (disableError) {
    let gone = true
    let readError
    try {
      const current = await readLandingCoordinates(cwd, pr, gh, git)
      const blocked = await bindLandingBase(cwd, pr, gh, git, state, current.base)
      if (blocked) return { terminal: blocked }
      gone = !current.head || current.head !== state.records.head
    } catch (error) {
      readError = error
    }
    if (gone) {
      return { terminal: landingExit(undefined, { policy: 'unarmed', adapter: 'disable', disableError, readError }) }
    }
    const known = knownLandingGate(state.gate, armedAuto, armedLabel)
    const names = []
    if (known.autoMergeRequest) names.push('auto-merge')
    if (known.labels.some((label) => label?.name === 'reviewed')) names.push('the reviewed label')
    return {
      terminal: landingExit({
        status: 'auto-merge-failed',
        armed: true,
        error: `PR ${pr} stays armed — ${names.join(' and ')} (--disable-auto failed: ${errorText(disableError)})`,
      }),
    }
  }
  const prepared = await refreshAndCheck(cwd, pr, gh, git, state, armedAuto, armedLabel)
  if (prepared.terminal) return prepared
  pin[pin.length - 1] = prepared.state.records.head
  try {
    await gh(cwd, pin)
  } catch {
    return { terminal: await refusedNativePin(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel) }
  }
  return prepared
}

export async function armMergeOnGreen(cwd, pr, gh, git, _sleep, state, armedAuto, armedLabel, owner) {
  const policy = await authorization.policyFromRepository({ cwd, gh })
  if (!policy) throw new Error('head authorization policy is not configured')
  const snapshot = await authorization.captureAuthorization({ cwd, gh, prNumber: Number(pr), policy })
  if (
    snapshot.scope.headSha !== state.records.head ||
    snapshot.scope.baseRef !== state.landingBase ||
    snapshot.scope.baseSha !== state.landingContext.tip
  ) {
    return { terminal: landingExit({ status: 'not-approved', reason: 'head-moved' }, { policy: 'unarmed' }), state }
  }
  const prepared = await refreshAndCheck(cwd, pr, gh, git, state, armedAuto, armedLabel)
  if (prepared.terminal) return prepared
  if (
    prepared.state.records.head !== snapshot.scope.headSha ||
    prepared.state.landingBase !== snapshot.scope.baseRef ||
    prepared.state.landingContext.tip !== snapshot.scope.baseSha ||
    !prepared.state.records.reviewId
  ) {
    return {
      terminal: landingExit({ status: 'not-approved', reason: 'head-moved' }, { policy: 'unarmed' }),
      state: prepared.state,
    }
  }
  // A POST can succeed despite a lost response. The epilogue must withdraw it.
  if (owner) owner.armedLabel = true
  armedLabel = true
  const receipt = await authorization.issueAuthorization({
    cwd,
    gh,
    snapshot,
    policy,
    lane: 'reviewed',
    source: 'native',
    requireBaseSha: true,
    evidence: prepared.state.records.reviewId,
    operationId: randomUUID(),
  })
  const moved = await refuseIfLandingMoved(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel)
  if (moved) return { terminal: moved, state: prepared.state, armedAuto, armedLabel }
  const since = receipt.createdAt.replace(/\.\d+Z$/, 'Z')
  return { state: prepared.state, armedAuto, armedLabel, since }
}

export async function armNative(cwd, pr, gh, git, state, armedAuto, armedLabel, owner) {
  let prepared = await refreshAndCheck(cwd, pr, gh, git, state, armedAuto, armedLabel)
  if (prepared.terminal) return prepared
  const pin = ['pr', 'merge', String(pr), '--auto', '--merge', '--match-head-commit', prepared.state.records.head]
  armedAuto = true
  if (owner) owner.armedAuto = true
  try {
    await gh(cwd, pin)
  } catch (error) {
    if (!/already enabled/i.test(errorText(error))) {
      return {
        terminal: await refusedNativePin(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel),
        state: prepared.state,
        armedAuto,
        armedLabel,
      }
    }
    const repinned = await repinExisting(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel, pin)
    if (repinned.terminal) {
      return { ...repinned, state: repinned.state ?? prepared.state, armedAuto, armedLabel }
    }
    prepared = repinned
  }
  const afterPin = await afterNativeWrite(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel)
  if (afterPin.terminal) {
    return { ...afterPin, state: afterPin.state ?? prepared.state, armedAuto, armedLabel }
  }
  prepared = afterPin
  const status = await gh(cwd, ['pr', 'view', String(pr), '--json', 'state', '--jq', '.state'])
  if (status.trim() === 'MERGED') {
    return { terminal: landingExit({ status: 'merged' }), state: prepared.state, armedAuto, armedLabel }
  }
  const behind = await checkBeforeArm(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel)
  if (behind) return { terminal: behind, state: prepared.state, armedAuto, armedLabel }
  const added = await writeLandingLabel(
    cwd,
    pr,
    gh,
    git,
    prepared.state,
    armedAuto,
    armedLabel,
    ['pr', 'edit', String(pr), '--add-label', 'reviewed'],
    true,
    owner,
  )
  if (added.terminal) return { ...added, state: prepared.state, armedAuto }
  armedLabel = added.armedLabel
  const afterAdd = await refuseIfLandingMoved(cwd, pr, gh, git, prepared.state, armedAuto, armedLabel)
  if (afterAdd) return { terminal: afterAdd, state: prepared.state, armedAuto, armedLabel }
  return { state: prepared.state, armedAuto, armedLabel }
}
