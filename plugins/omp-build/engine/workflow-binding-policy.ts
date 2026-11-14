import type { MandateRecord } from './workflow-control.ts'

/** A version identifies a writer contract, never by itself a covered historical prefix. */
export function bindingPolicy(mandate: MandateRecord): 'legacy' | 'bounded' | 'unknown' {
  const match = /^(0)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(mandate.payload.config.productVersion)
  if (match === null) return 'unknown'
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (!Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return 'unknown'
  if (minor < 18 || (minor === 18 && patch <= 7)) return 'legacy'
  if (minor === 18 && (patch === 8 || patch === 9 || patch === 10 || patch === 11)) return 'bounded'
  return 'unknown'
}

export function bindingMatchesMandate(mandate: MandateRecord, branch: string, base: string): boolean {
  return mandate.payload.branch !== null && mandate.payload.branch === branch && mandate.payload.base === base
}
