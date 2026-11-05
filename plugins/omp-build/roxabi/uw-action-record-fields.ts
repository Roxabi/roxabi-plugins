import type { CanonicalRecord } from '../engine/record-schema.ts'

export function field(value: unknown, key: string): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = (value as Record<string, unknown>)[key]
  return typeof item === 'string' ? item : null
}

export function inventoryIdsOf(record: CanonicalRecord): string[] {
  return Array.isArray((record.payload as { inventoryIds?: unknown }).inventoryIds)
    ? (record.payload as { inventoryIds: unknown[] }).inventoryIds.filter(
        (item): item is string => typeof item === 'string',
      )
    : []
}
