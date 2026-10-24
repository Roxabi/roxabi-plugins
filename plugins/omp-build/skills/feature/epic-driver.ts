import { frameEpicChildren, readEpicAuthority } from './epic-driver-authority'
import { main } from './epic-driver-cli'
import {
  disarmEpicControlTarget,
  epicFinalReviewRequest,
  readEpicControlTarget,
  readEpicStep,
} from './epic-driver-control'
import { next } from './epic-driver-next'
import { Assisted, type EpicEffects, Refused, withEpicEffects } from './epic-driver-runtime'
import { hook, markFix, report, review, stop } from './epic-driver-terminal'

export type { EpicAuthority, EpicChildGrant } from './epic-driver-authority'
export { assertChildGrant, frameEpicChildren, readEpicAuthority } from './epic-driver-authority'
export type {
  EpicControlState,
  EpicControlTarget,
  EpicDisarmEvidence,
  EpicRangeReviewRequest,
  EpicStepRead,
} from './epic-driver-control'
export {
  disarmEpicControlTarget,
  epicFinalReviewRequest,
  readEpicControlTarget,
  readEpicStep,
} from './epic-driver-control'
export type { NextOut } from './epic-driver-next'
export type { ConfigCheck, EpicEffects, EpicGh, EpicGit } from './epic-driver-runtime'

export type EpicDriverPort = {
  readEpicAuthority: typeof readEpicAuthority
  frameEpicChildren: typeof frameEpicChildren
  next: typeof next
  readEpicStep: typeof readEpicStep
  stop: typeof stop
  markFix: typeof markFix
  review: typeof review
  hook: typeof hook
  report: typeof report
  epicFinalReviewRequest: typeof epicFinalReviewRequest
  readEpicControlTarget: typeof readEpicControlTarget
  disarmEpicControlTarget: typeof disarmEpicControlTarget
}

export function createEpicDriver(injected: EpicEffects = {}): EpicDriverPort {
  const bind =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      withEpicEffects(injected, () => fn(...args))
  return {
    readEpicAuthority: bind(readEpicAuthority),
    frameEpicChildren: bind(frameEpicChildren),
    next: bind(next),
    readEpicStep: bind(readEpicStep),
    stop: bind(stop),
    markFix: bind(markFix),
    review: bind(review),
    hook: bind(hook),
    report: bind(report),
    epicFinalReviewRequest: bind(epicFinalReviewRequest),
    readEpicControlTarget: bind(readEpicControlTarget),
    disarmEpicControlTarget: bind(disarmEpicControlTarget),
  }
}

const realDriver = createEpicDriver()
export const epicNext = realDriver.next
export const epicStep = realDriver.readEpicStep
export const epicStop = realDriver.stop
export const epicMarkFix = realDriver.markFix
export const epicHook = realDriver.hook
export const epicReport = realDriver.report
export const epicBindReview = realDriver.review
export const epicControlTarget = realDriver.readEpicControlTarget
export const epicDisarmControl = realDriver.disarmEpicControlTarget

if (import.meta.main) {
  try {
    console.log(await main(process.argv.slice(2)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [code, tag] =
      error instanceof Assisted ? [3, 'assisted'] : error instanceof Refused ? [2, 'refused'] : [1, 'failed']
    console.error(`driver=${tag} ${message}`)
    process.exit(code)
  }
}
