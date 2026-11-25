import type { MandateRecord } from './workflow-control.ts'

/** Historical writers before bounded bindings used the PR claim as the branch/base source.
 * The mandate schema did not change at that cutover; its recorded producer identifies the legacy writer.
 */
export function usesLegacyBindingFormat(mandate: MandateRecord): boolean {
  const match = /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(mandate.payload.config.productVersion)
  if (match === null) return false
  const minor = Number(match[1])
  const patch = Number(match[2])
  return Number.isSafeInteger(patch) && (minor < 18 || (minor === 18 && patch <= 7))
}

export function bindingMatchesMandate(mandate: MandateRecord, branch: string, base: string): boolean {
  return mandate.payload.branch !== null && mandate.payload.branch === branch && mandate.payload.base === base
}
