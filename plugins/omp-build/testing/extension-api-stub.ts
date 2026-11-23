import type { OmpBuildExtensionApi } from '../omp/omp-controller'

/** Public extension I/O exercised by ompBuildExtension. */
export type ExtensionApiStub = OmpBuildExtensionApi

/**
 * Runtime/type harness for entry registration. Product requires these public
 * members; tests must supply them rather than weakening product optionality.
 */
export function createExtensionApiStub(overrides: Partial<ExtensionApiStub> = {}): ExtensionApiStub {
  return {
    on: () => undefined,
    registerCommand: () => undefined,
    registerShortcut: () => undefined,
    registerTool: () => undefined,
    sendUserMessage: async () => undefined,
    sendMessage: () => undefined,
    getAllTools: () => [],
    exec: async () => {
      throw new Error('exec-unavailable')
    },
    ...overrides,
  }
}
