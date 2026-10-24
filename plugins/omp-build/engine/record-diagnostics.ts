import type { Diagnostic, Json, Scope } from './record-values.ts'

type RecordReference = { recordId: string; kind: string; scope: Scope }
type FailureMetadata = {
  knownReviews?: number
  countExact?: boolean
  spent?: boolean | null
}

export function diagnostic(code: string, message: string, detail?: Json): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

export function fail(
  diagnostics: Diagnostic[],
  metadata: FailureMetadata = {},
): FailureMetadata & {
  ok: false
  diagnostics: Diagnostic[]
} {
  return { ok: false, diagnostics, ...metadata }
}

export function equalScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

export function sameRef(left: RecordReference, right: RecordReference): boolean {
  return left.recordId === right.recordId && left.kind === right.kind && equalScope(left.scope, right.scope)
}
