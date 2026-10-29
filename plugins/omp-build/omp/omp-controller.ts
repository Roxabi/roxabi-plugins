import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import type { ReviewPublisher } from '../roxabi/review-contract.ts'
import { ReviewProduct } from '../roxabi/review-dispatch.ts'
import { installNativeBatchBridge } from './review-runtime/bridge.ts'
import type { NativeBatch, NativeExtension } from './review-runtime/contracts.ts'
import { NativeBatchController } from './review-runtime/controller.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

export type OmpBuildExtensionApi = Pick<
  ExtensionAPI,
  | 'on'
  | 'registerCommand'
  | 'registerTool'
  | 'sendUserMessage'
  | 'sendMessage'
  | 'exec'
  | 'getActiveTools'
  | 'getAllTools'
  | 'setActiveTools'
> & {
  events: ExtensionAPI['events']
}

/** Terminal/control reports need only non-steering sendMessage. */
export type TerminalStatusHost = Pick<ExtensionAPI, 'sendMessage'>
/** Fix/CI ownership + terminal notify: native bridge plus sendMessage. */
export type FixHost = NativeExtension & TerminalStatusHost

export type OwnedFixRun = {
  run: FixRun
  reporting: Promise<void>
  release: Promise<void>
  stopping?: Promise<void>
  tearingDown?: true
}

const reviewControllers = new WeakMap<object, NativeBatchController>()
const ownedFixRuns = new WeakMap<object, OwnedFixRun>()

/** Operator-visible terminal/control status: never starts or steers a model turn. */
export function reportFeatureTerminalStatus(pi: TerminalStatusHost, text: string): void {
  pi.sendMessage(text, { triggerTurn: false })
}

export function ownedFixRunFor(pi: NativeExtension): OwnedFixRun | undefined {
  return ownedFixRuns.get(pi)
}

export function hasOwnedFixRun(pi: NativeExtension): boolean {
  return ownedFixRuns.has(pi)
}

export function ownFixRun(pi: NativeExtension, owned: OwnedFixRun): void {
  ownedFixRuns.set(pi, owned)
}

export function releaseOwnedFixRun(pi: NativeExtension, run: FixRun): void {
  if (ownedFixRuns.get(pi)?.run === run) ownedFixRuns.delete(pi)
}

export function interruptOwnedFixRun(pi: NativeExtension, reason: string): void {
  const owned = ownedFixRuns.get(pi)
  if (!owned || owned.stopping !== undefined) return
  owned.tearingDown = true
  owned.stopping = owned.run.stop(reason).catch((error) => {
    console.error(
      `omp-build: fix run ${owned.run.runId} stop failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

export function interruptExactOwnedFixRun(pi: NativeExtension, owned: OwnedFixRun, reason: string): void {
  if (ownedFixRuns.get(pi) !== owned) return
  interruptOwnedFixRun(pi, reason)
}

/** One controller and one native bridge for the lifetime of each extension instance. */
export function reviewControllerFor(pi: NativeExtension): NativeBatchController {
  const existing = reviewControllers.get(pi)
  if (existing) return existing
  const controller = new NativeBatchController()
  installNativeBatchBridge(pi, controller)
  reviewControllers.set(pi, controller)
  return controller
}

/** Feature/Epic host entry: the caller supplies only a real authorization/publishing boundary. */
export function createOmpReviewProduct(pi: NativeExtension, publisher: ReviewPublisher): ReviewProduct {
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  const controller = reviewControllerFor(pi)
  return new ReviewProduct(createNativeReviewPort(pi, controller), publisher, {
    canDispatch: () => !hasOwnedFixRun(pi) && !controller.featureContinuationInhibited(),
    refusalReason: () => (controller.featureContinuationInhibited() ? 'continuation-inhibited' : 'fix-run-active'),
  })
}

/** Correction batches share the same guarded native bridge and native continuation. */
export function createOmpFixPort(
  pi: NativeExtension,
): Pick<NativeBatchController, 'active' | 'activate' | 'stopOwned'> & { announce(batch: NativeBatch): Promise<void> } {
  const controller = reviewControllerFor(pi)
  return {
    active: controller.active.bind(controller),
    activate: controller.activate.bind(controller),
    stopOwned: controller.stopOwned.bind(controller),
    announce: createNativeReviewPort(pi, controller).announce,
  }
}
