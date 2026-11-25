import type { CanonicalRecord } from './record-schema.ts'

/** Identifies the old continuation controls without granting them live authority. */
export function isHistoricalContinuationControl(record: CanonicalRecord | null): boolean {
  if (record?.kind !== 'operator-control') return false
  const { control } = record.payload
  return (
    control === 'pause-requested' ||
    control === 'pause-confirmed' ||
    control === 'resume' ||
    control === 'resolve-interruption'
  )
}
