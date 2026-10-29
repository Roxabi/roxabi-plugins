import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Json } from './record-values.ts'

export function collectOriginals(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  records: ReadonlyMap<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): Map<string, Json> {
  const originals = new Map<string, Json>()
  for (const sourceId of record.payload.judgment.sourceContributionIds) {
    const source = records.get(sourceId)
    if (source?.kind !== 'contribution' || source.payload.content !== 'findings' || source.payload.findings === null) {
      diagnostics.push(diagnostic('missing-contribution', `Decision source ${sourceId} is unavailable`))
      continue
    }
    for (const original of source.payload.findings) {
      if (originals.has(original.id)) {
        diagnostics.push(
          diagnostic('duplicate-reference', `Original finding ${original.id} occurs in multiple sources`),
        )
      }
      originals.set(original.id, original.data)
    }
  }
  return originals
}
