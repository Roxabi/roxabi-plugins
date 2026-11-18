import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import type { FixRun } from '../roxabi/fix-entry-lifecycle.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { belongsToFixFence } from '../roxabi/fix-fence-batches.ts'
import type { ReviewPublisher } from '../roxabi/review-contract.ts'
import { ReviewProduct } from '../roxabi/review-dispatch.ts'
import { installNativeBatchBridge } from './review-runtime/bridge.ts'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeChildResult,
  NativeExtension,
} from './review-runtime/contracts.ts'
import { NativeBatchController } from './review-runtime/controller.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

export type OmpBuildExtensionApi = Pick<
  ExtensionAPI,
  | 'on'
  | 'registerCommand'
  | 'registerShortcut'
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
const fixIngress = new WeakSet<object>()
const fixFences = new WeakMap<object, FixExecutionFence>()

/** Serialize the outer async ingress as well as the subsequently owned driver. */
export function claimFixIngress(pi: NativeExtension): () => void {
  if (hasOwnedFixRun(pi)) throw new Error('fix-run-already-active')
  if (reviewControllers.get(pi)?.hasLiveBatchExcept(() => false)) throw new Error('fix-known-native-writer-active')
  fixIngress.add(pi)
  return () => {
    fixIngress.delete(pi)
    if (!ownedFixRuns.has(pi)) fixFences.delete(pi)
  }
}

/** Operator-visible terminal/control status: never starts or steers a model turn. */
export function reportFeatureTerminalStatus(pi: TerminalStatusHost, text: string): void {
  pi.sendMessage(text, { triggerTurn: false })
}

export function ownedFixRunFor(pi: NativeExtension): OwnedFixRun | undefined {
  return ownedFixRuns.get(pi)
}

export function hasOwnedFixRun(pi: NativeExtension): boolean {
  return fixIngress.has(pi) || ownedFixRuns.has(pi)
}

export function ownFixRun(pi: NativeExtension, owned: OwnedFixRun): void {
  ownedFixRuns.set(pi, owned)
}

export function releaseOwnedFixRun(pi: NativeExtension, run: FixRun): void {
  if (ownedFixRuns.get(pi)?.run === run) {
    ownedFixRuns.delete(pi)
    fixFences.delete(pi)
  }
}

export function interruptOwnedFixRun(pi: NativeExtension, reason: string): Promise<void> | undefined {
  const owned = ownedFixRuns.get(pi)
  if (!owned) return undefined
  if (owned.stopping !== undefined) return owned.stopping
  owned.tearingDown = true
  try {
    owned.stopping = owned.run.stop(reason)
  } catch (error) {
    owned.stopping = Promise.reject(error)
  }
  void owned.stopping.catch((error) => {
    console.error(
      `omp-build: fix run ${owned.run.runId} stop failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  return owned.stopping
}

export function interruptExactOwnedFixRun(pi: NativeExtension, owned: OwnedFixRun, reason: string): void {
  if (ownedFixRuns.get(pi) !== owned) return
  void interruptOwnedFixRun(pi, reason)
}

/** One controller and one native bridge for the lifetime of each extension instance. */
export function reviewControllerFor(pi: NativeExtension): NativeBatchController {
  const existing = reviewControllers.get(pi)
  if (existing) return existing
  const controller = new NativeBatchController((batch) => {
    if (!hasOwnedFixRun(pi)) return true
    const fence = fixFences.get(pi)
    return fence !== undefined && belongsToFixFence(batch, fence)
  })
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
  suppliedFence?: FixExecutionFence,
): Pick<NativeBatchController, 'active' | 'activate' | 'stopOwned'> & {
  announce(batch: NativeBatch, current?: () => boolean): Promise<void>
  executionFence: FixExecutionFence
} {
  const executionFence = suppliedFence ?? new FixExecutionFence()
  const controller = reviewControllerFor(pi)
  if (suppliedFence !== undefined && fixIngress.has(pi)) fixFences.set(pi, suppliedFence)
  executionFence.bindKnownWriters(
    () => !controller.hasLiveBatchExcept((batch) => belongsToFixFence(batch, executionFence)),
  )
  return {
    active: controller.active.bind(controller),
    executionFence,
    activate(batch, callbacks) {
      executionFence.bind(batch)
      const onChildResult = callbacks.onChildResult
      const onSettled = callbacks.onSettled
      const tracked: NativeBatchCallbacks = {
        ...(onChildResult === undefined
          ? {}
          : {
              onChildResult: (child: NativeChildResult) =>
                executionFence.trackCallback('onChildResult', () => onChildResult(child)),
            }),
        onComplete: (result, canContinue) =>
          executionFence.trackCallback('onComplete', () => callbacks.onComplete(result, canContinue)),
        ...(onSettled === undefined
          ? {}
          : {
              onSettled: (result: NativeBatchResult, canContinue: () => boolean) =>
                executionFence.trackCallback('onSettled', async () => {
                  const successor = await onSettled(result, canContinue)
                  return typeof successor === 'function' ? successor : undefined
                }),
            }),
        onStop: (reason, result, stop) =>
          executionFence.trackCallback('onStop', () => callbacks.onStop(reason, result, stop)),
      }
      controller.activate(batch, tracked)
    },
    stopOwned: controller.stopOwned.bind(controller),
    announce: createNativeReviewPort(pi, controller).announce,
  }
}
