/** Bun-only fixture boundary; the host runtime, not the model, supplies scoped SDK settings. */
import { mock } from 'bun:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'

export async function installFixtureSdkSettings(
  cwd: string,
  overrides: Record<string, string | string[]> = {},
): Promise<void> {
  if (!cwd) throw new Error('fixture-sdk-settings-root-missing')
  const resolved = import.meta.resolve('@oh-my-pi/pi-coding-agent')
  const sdkPath = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved
  const facade = {
    SettingsManager: {
      create(requestedCwd: string) {
        if (requestedCwd !== cwd) throw new Error('fixture-sdk-settings-unknown-root')
        return Settings.isolated({ 'task.agentModelOverrides': overrides })
      },
    },
  }
  // The extension loader redirects the package root to this distinct source shim.
  const shimPath = join(dirname(sdkPath), 'extensibility/legacy-pi-coding-agent-shim.ts')
  mock.module(sdkPath, () => facade)
  mock.module(shimPath, () => facade)
  mock.module('@oh-my-pi/pi-coding-agent', () => facade)
  await import('@oh-my-pi/pi-coding-agent/extensibility/extensions')
}
