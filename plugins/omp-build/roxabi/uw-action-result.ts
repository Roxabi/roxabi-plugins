import { createHash } from 'node:crypto'
import type { Diagnostic, Json } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { canonicalJson } from './workflow-config-digest.ts'

export function actionFailure(code: string, message: string, detail?: Json): Result<never> {
  const diagnostic: Diagnostic = detail === undefined ? { code, message } : { code, message, detail }
  return { ok: false, diagnostics: [diagnostic] }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function isGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}
