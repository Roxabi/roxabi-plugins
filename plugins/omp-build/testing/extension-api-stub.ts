import { EventBus } from '@oh-my-pi/pi-coding-agent/utils/event-bus'
import type { OmpBuildExtensionApi } from '../omp/omp-controller'

/** Public extension I/O actually exercised by ompBuildExtension + the native bridge. */
export type ExtensionApiStub = OmpBuildExtensionApi

/** Real SDK bus with an optional observer for fixtures that expose registered listeners. */
export function fixtureEventBus(
  register?: (channel: string, handler: (data: unknown) => void) => () => void,
): EventBus {
  const bus = new EventBus()
  if (register) {
    const subscribe = bus.on.bind(bus)
    bus.on = (channel, handler) => {
      const unsubscribe = subscribe(channel, handler)
      const unregister = register(channel, handler)
      return () => {
        unsubscribe()
        unregister()
      }
    }
  }
  return bus
}

/**
 * Runtime/type harness for entry registration. Product requires these public
 * members; tests must supply them rather than weakening product optionality.
 */
export function createExtensionApiStub(overrides: Partial<ExtensionApiStub> = {}): ExtensionApiStub {
  const { events, ...rest } = overrides
  let activeTools: string[] = []
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    registerTool: () => undefined,
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
    getActiveTools: () => activeTools,
    getAllTools: () => [],
    setActiveTools: async (names) => {
      activeTools = [...names]
    },
    exec: async () => {
      throw new Error('exec-unavailable')
    },
    ...rest,
    events: events ?? fixtureEventBus(),
  }
}
