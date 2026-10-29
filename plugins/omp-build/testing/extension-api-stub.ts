import type { OmpBuildExtensionApi } from '../omp/omp-controller'

/** Public extension I/O actually exercised by ompBuildExtension + the native bridge. */
export type ExtensionApiStub = OmpBuildExtensionApi

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
    events: events ?? { on: () => () => undefined },
  }
}
