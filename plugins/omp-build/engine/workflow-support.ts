import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic, Json, Scope } from './record-values.ts'
import type { Result } from './result.ts'

export const diagnostic = (code: string, message: string, detail?: Json): Diagnostic =>
  detail === undefined ? { code, message } : { code, message, detail }
export const fail = <T>(diagnostics: Diagnostic[]): Result<T> => ({ ok: false, diagnostics })
export const equalScope = (left: Scope, right: Scope): boolean =>
  left.repository === right.repository && left.target === right.target
export const sameRef = (left: ExternalRecordRef, right: ExternalRecordRef): boolean =>
  left.recordId === right.recordId && left.kind === right.kind && equalScope(left.scope, right.scope)
