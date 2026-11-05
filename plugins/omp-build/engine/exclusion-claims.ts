import { assessExclusion } from './criterion-admission.ts'
import type { ExclusionClaim } from './criterion-verdict-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { FinalFinding } from './review-schema.ts'
import type { SpecEffective } from './spec-effective.ts'

/** Validate every claim, including conflicting classifications for one original. */
export function validateExclusionClaims(input: {
  spec: SpecEffective
  claims: readonly ExclusionClaim[]
  retained: ReadonlySet<string>
  findings: readonly FinalFinding[]
}): Map<string, Diagnostic[]> {
  const bySource = new Map<string, Diagnostic[]>()
  const concerns = new Map<string, Set<ExclusionClaim['concern']>>()
  for (const claim of input.claims) {
    const errors = bySource.get(claim.sourceFindingId) ?? []
    bySource.set(claim.sourceFindingId, errors)
    if (!input.retained.has(claim.sourceFindingId))
      errors.push(diagnostic('unknown-reference', `Exclusion ${claim.sourceFindingId} is not a retained original`))
    const finding = input.findings.find((item) => item.sourceFindingIds.includes(claim.sourceFindingId))
    if (finding === undefined || JSON.stringify(claim.target) !== JSON.stringify(finding.target))
      errors.push(
        diagnostic('exclusion-target-mismatch', `Exclusion ${claim.sourceFindingId} does not match its finding target`),
      )
    const assessed = assessExclusion({ spec: input.spec, claim })
    if (!assessed.ok) errors.push(...assessed.diagnostics)
    const classified = concerns.get(claim.sourceFindingId) ?? new Set<ExclusionClaim['concern']>()
    classified.add(claim.concern)
    concerns.set(claim.sourceFindingId, classified)
  }
  for (const [source, values] of concerns) {
    if (values.size > 1)
      bySource
        .get(source)
        ?.push(diagnostic('exclusion-claim-conflict', `Exclusion ${source} has conflicting classifications`))
  }
  return bySource
}
