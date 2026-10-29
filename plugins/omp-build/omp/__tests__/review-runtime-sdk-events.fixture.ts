import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import { installNativeBatchBridge } from '../review-runtime/bridge.ts'
import { NativeBatchController } from '../review-runtime/controller.ts'

type Handler = (...args: never[]) => unknown
type Bus = {
  api: { on(name: string, handler: (value: unknown) => void): () => void }
  emit(name: string, value: unknown): void
}
export type ToolEntry = { name: string; source: string }

export const tools = ['read', 'grep', 'glob', 'lsp', 'ast_grep']

export function endpoint(
  bus: Bus,
  beforeSetTools?: () => Promise<void>,
  registry?: ToolEntry[],
  initialTools?: string[],
) {
  const handlers = new Map<string, Handler[]>()
  let activeTools = initialTools ? [...initialTools] : [...tools, 'yield']
  const registered = registry
    ? registry.map((tool) => ({ ...tool }))
    : activeTools.map((name) => ({ name, source: 'builtin' }))
  const native = createExtensionApiStub({
    events: bus.api,
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]),
    getActiveTools: () => activeTools,
    getAllTools: () => registered.map(({ name, source }) => ({ name, sourceInfo: { source } })) as never,
    setActiveTools: async (names) => {
      await beforeSetTools?.()
      activeTools = [...names]
    },
  })
  const controller = new NativeBatchController()
  controller.bindHostGit(() => null)
  installNativeBatchBridge(native, controller)
  return {
    controller,
    async emit(name: string, event: unknown, ctx: unknown) {
      let response: unknown
      for (const handler of handlers.get(name) ?? [])
        response = (await handler(event as never, ctx as never)) ?? response
      return response
    },
    activeTools: () => [...activeTools],
    setSource(name: string, source: string) {
      for (const tool of registered) if (tool.name === name) tool.source = source
    },
    addTool(name: string) {
      activeTools.push(name)
      registered.push({ name, source: 'builtin' })
    },
  }
}

export function eventBus(): Bus {
  const listeners = new Map<string, ((value: unknown) => void)[]>()
  return {
    api: {
      on: (name: string, handler: (value: unknown) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler])
        return () => undefined
      },
    },
    emit(name: string, value: unknown) {
      for (const listener of listeners.get(name) ?? []) listener(value)
    },
  }
}
