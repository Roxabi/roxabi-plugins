/** Explicit test-only root settings; never grants native execution on its own. */
export const unitSdkRoots = new Map<string, unknown>()

export function provisionUnitSdkRoot(cwd: string, overrides: unknown = {}): void {
  unitSdkRoots.set(cwd, overrides)
}
