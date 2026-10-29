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
function pointerChild(current: unknown, raw: string): Result<unknown> {
  const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
  if (Array.isArray(current)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || current[index] === undefined) {
      return actionFailure('record-unreadable', 'JSON pointer does not match the authenticated record')
    }
    return { ok: true, value: current[index] }
  }
  if (current === null || typeof current !== 'object' || !(key in current)) {
    return actionFailure('record-unreadable', 'JSON pointer does not match the authenticated record')
  }
  return { ok: true, value: (current as Record<string, unknown>)[key] }
}

export function jsonPointer(value: unknown, selector: string): Result<Json> {
  if (!selector.startsWith('/')) return actionFailure('record-unreadable', 'Selector is not a JSON pointer')
  let current: unknown = value
  if (selector !== '/') {
    for (const raw of selector.slice(1).split('/')) {
      const stepped = pointerChild(current, raw)
      if (!stepped.ok) return stepped
      current = stepped.value
    }
  }
  return { ok: true, value: current as Json }
}

export function sameScope(
  left: { repository: string; target: string },
  right: { repository: string; target: string },
): boolean {
  return left.repository === right.repository && left.target === right.target
}
