import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { readSimClient } from '../skills/feature/testing/gh-simulator/sim-client-script.ts'

const faultScript = join(import.meta.dirname, 'fix-recovery-gh-fault.ts')

/**
 * True when `gh` resolves to the recovery fault fixture: this repository's fault script, or a
 * per-file client whose whole text is the generated fault-mode client falling back to that script.
 */
export function isRecoveryFaultGh(gh: string): boolean {
  const resolved = realpathSync(gh)
  const script = realpathSync(faultScript)
  if (resolved === script) return true
  // Generated clients are a few KiB; anything larger (a real gh binary) is not one.
  if (statSync(resolved).size > 65_536) return false
  const client = readSimClient(readFileSync(resolved, 'utf8'))
  return client?.mode === 'fault' && existsSync(client.fallback) && realpathSync(client.fallback) === script
}
