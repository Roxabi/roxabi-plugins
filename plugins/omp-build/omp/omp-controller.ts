import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { installNativeBatchBridge } from './review-runtime/bridge.ts'
import type { NativeExtension } from './review-runtime/contracts.ts'
import { NativeBatchController } from './review-runtime/controller.ts'

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
const reviewControllers = new WeakMap<object, NativeBatchController>()

/** Operator-visible terminal/control status: never starts or steers a model turn. */
export function reportFeatureTerminalStatus(pi: TerminalStatusHost, text: string): void {
  pi.sendMessage(text, { triggerTurn: false })
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
