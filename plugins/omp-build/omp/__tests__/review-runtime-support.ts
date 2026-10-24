import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import type { NativeBatch, NativeExtension } from '../review-runtime/contracts.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'
import { createExtensionApiStub, type ExtensionApiStub } from './extension-api-stub.ts'

function userMessageText(content: Parameters<ExtensionApiStub['sendUserMessage']>[0]): string {
  if (typeof content === 'string') return content
  return content.reduce((text, block) => (block.type === 'text' ? text + block.text : text), '')
}

type RegisteredHandler = (...args: never[]) => unknown

export type BridgeHarness = {
  controller: NativeBatchController
  native: NativeExtension
  messages: string[]
  emitBridge(event: string, ...args: unknown[]): Promise<unknown>
  emitRaw(value: unknown): void
}

export const root = { agent: { kind: 'main', id: 'Main', name: 'main', depth: 0 } }

export function bridgeHarness(): BridgeHarness {
  const handlers = new Map<string, RegisteredHandler>()
  const messages: string[] = []
  let rawHandler: ((value: unknown) => void) | undefined
  const native: NativeExtension = createExtensionApiStub({
    events: {
      on: (_channel, handler) => {
        rawHandler = handler
        return () => {
          rawHandler = undefined
        }
      },
    },
    on: (event, handler) => {
      handlers.set(event, handler)
    },
    sendUserMessage: async (content) => {
      messages.push(userMessageText(content))
    },
  })
  const controller = new NativeBatchController()
  installNativeBatchBridge(native, controller)
  return {
    controller,
    native,
    messages,
    async emitBridge(event, ...args) {
      const handler = handlers.get(event)
      return handler === undefined ? undefined : await handler(...(args as never[]))
    },
    emitRaw(value) {
      rawHandler?.(value)
    },
  }
}

export function batch(names: readonly string[]): NativeBatch {
  return {
    operationId: 'native-op',
    tasks: {
      context: 'native bridge fixture',
      tasks: names.map((name) => ({ name, agent: 'reviewer', task: name, solutionSpace: 'fixed fixture' })),
    },
  }
}
