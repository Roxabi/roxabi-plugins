import { encodeParts } from '../adapters/github/history-encoder.ts'
import { parseRecord } from '../engine/record-construction.ts'

/** Canonicalize external envelopes before encoding their simulated comment frames. */
export function frameFixRecoveryFixture(record: unknown) {
  const parsed = parseRecord(record)
  if (!parsed.ok) throw new Error(`fixture-envelope-invalid:${JSON.stringify(parsed.diagnostics)}`)
  const result = encodeParts(parsed.value, '', 65536)
  if (!result.ok) throw new Error('fixture-frame-invalid')
  return result.value
}
