import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'

export type OmpBuildExtensionApi = Pick<
  ExtensionAPI,
  | 'on'
  | 'registerCommand'
  | 'registerShortcut'
  | 'registerTool'
  | 'sendUserMessage'
  | 'sendMessage'
  | 'exec'
  | 'getAllTools'
>

/** Terminal/control reports need only non-steering sendMessage. */
export type TerminalStatusHost = Pick<ExtensionAPI, 'sendMessage'>

/** Operator-visible terminal/control status: never starts or steers a model turn. */
export function reportFeatureTerminalStatus(pi: TerminalStatusHost, text: string): void {
  pi.sendMessage(text, { triggerTurn: false })
}
