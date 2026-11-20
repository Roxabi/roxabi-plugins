import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const faultScript = join(import.meta.dirname, 'fix-recovery-gh-fault.ts')

/**
 * True when `gh` resolves to the recovery fault fixture: this repository's fault script, or a
 * per-file fault client written by the integration setup. A client qualifies only by its own text:
 * it sends fault-mode requests and falls back to this repository's fault script.
 */
export function isRecoveryFaultGh(gh: string): boolean {
  const resolved = realpathSync(gh)
  const script = realpathSync(faultScript)
  if (resolved === script) return true
  const text = readFileSync(resolved, 'utf8')
  const fallback = /^\[\[ -z \$use_standalone \]\] \|\| exec bun '([^']+)' "\$@"$/m.exec(text)?.[1]
  return (
    text.startsWith('#!/bin/bash\n') &&
    text.includes(`"$stdin_path" 'fault' >&3`) &&
    fallback !== undefined &&
    realpathSync(fallback) === script
  )
}
