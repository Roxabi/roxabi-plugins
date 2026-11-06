import { createHash } from 'node:crypto'

export function orderedCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedCanonicalValue)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) sorted[key] = orderedCanonicalValue(source[key])
    return sorted
  }
  return value
}

/** Stable digest of a value with canonical object-key order and unchanged array order. */
export function canonicalValueDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(orderedCanonicalValue(value)), 'utf8')
    .digest('hex')
}
