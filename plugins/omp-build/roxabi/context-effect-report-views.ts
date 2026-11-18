import { canonicalValueDigest } from '../dist/contracts.js'
import type { ContextEffectReportView } from '../engine/context-effect-sources.ts'
import type { ContextSuccessionProposal } from '../engine/workflow-context-disposition-schema.ts'

/** Display integrity only; engine admission owns effect eligibility and resource reconciliation. */
export function matchingContextEffectReports(
  proposal: ContextSuccessionProposal,
  reports: readonly ContextEffectReportView[] | undefined,
): boolean {
  if (reports === undefined) return false
  const expected = proposal.reconciliation.effectReview.intent.negatives
  if (reports.length !== expected.length) return false
  const bySource = new Map(reports.map((report) => [canonicalValueDigest(report.source), report]))
  if (bySource.size !== reports.length) return false
  const sources = new Set<string>()
  for (const negative of expected) {
    const key = canonicalValueDigest(negative.source)
    if (sources.has(key)) return false
    sources.add(key)
    const report = bySource.get(key)
    if (report === undefined || canonicalValueDigest(report.payload) !== negative.source.digest) return false
  }
  return true
}
