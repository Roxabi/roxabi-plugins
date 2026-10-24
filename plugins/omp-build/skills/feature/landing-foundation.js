import { enforceArmedGate, readGate } from './workflow-gate.js'
import { gh } from './workflow-runtime.js'

export async function disarmReviewedBeforePush(cwd, pr, { gh: ghFn = gh, push } = {}) {
  let gate
  let failure
  try {
    gate = await readGate(cwd, pr, ghFn)
  } catch (error) {
    failure = error
  }
  const receipt = await enforceArmedGate(cwd, pr, {
    gate,
    policy: 'unarmed',
    gh: ghFn,
  })
  if (failure) throw failure
  if (push) await push()
  if (receipt.disarmed) return { disarmed: true }
  if (gate.state === 'MERGED') return { merged: true }
  if (gate.state === 'CLOSED') return { closed: true }
  return { unarmed: true }
}
