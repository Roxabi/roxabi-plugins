import { findingTargetSchema } from './finding-target-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Json } from './record-values.ts'
import { type FindingInspection, unique } from './result.ts'
import { causeSchema } from './review-schema.ts'
export function validateFinalFindingReferences(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  originals: ReadonlyMap<string, Json>,
  inspections: ReadonlyMap<string, FindingInspection>,
  diagnostics: Diagnostic[],
): Set<string> {
  const covered = new Set<string>()
  const findings = record.payload.judgment.findings
  if (!unique(findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats final finding IDs'))
  for (const finalFinding of findings) validateFinalFinding(finalFinding, originals, inspections, covered, diagnostics)
  return covered
}

type Judgment = Extract<CanonicalRecord, { kind: 'decision' }>['payload']['judgment']

function validateFinalFinding(
  finalFinding: Judgment['findings'][number],
  originals: ReadonlyMap<string, Json>,
  inspections: ReadonlyMap<string, FindingInspection>,
  covered: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (!unique(finalFinding.sourceFindingIds))
    diagnostics.push(diagnostic('duplicate-reference', `Final finding ${finalFinding.id} repeats a source`))
  if (
    finalFinding.state === 'usable' &&
    finalFinding.sourceFindingIds.length > 1 &&
    finalFinding.mergeReason === undefined
  )
    diagnostics.push(diagnostic('malformed', `Merged finding ${finalFinding.id} lacks merge reason`))
  for (const sourceId of finalFinding.sourceFindingIds)
    validateFindingSource(finalFinding, sourceId, originals, inspections, covered, diagnostics)
}

function validateFindingSource(
  finalFinding: Judgment['findings'][number],
  sourceId: string,
  originals: ReadonlyMap<string, Json>,
  inspections: ReadonlyMap<string, FindingInspection>,
  covered: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (!originals.has(sourceId)) {
    diagnostics.push(diagnostic('unknown-reference', `Final finding ${finalFinding.id} references ${sourceId}`))
    return
  }
  const original = originals.get(sourceId)
  if (finalFinding.state === 'usable' && original !== undefined) {
    const inspection = inspections.get(sourceId)
    if (inspection !== undefined && !inspection.usable) diagnostics.push(...inspection.diagnostics)
  }
  const rawTarget =
    original !== null && typeof original === 'object' && !Array.isArray(original) ? original.target : undefined
  const parsedTarget = findingTargetSchema.safeParse(rawTarget)
  if (JSON.stringify(parsedTarget.success ? parsedTarget.data : null) !== JSON.stringify(finalFinding.target))
    diagnostics.push(
      diagnostic(
        'finding-target-mismatch',
        `Final finding ${finalFinding.id} does not retain source ${sourceId}'s target`,
      ),
    )
  if (covered.has(sourceId))
    diagnostics.push(diagnostic('duplicate-reference', `Original finding ${sourceId} is covered more than once`))
  covered.add(sourceId)
}

export function validateCauseReferences(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  diagnostics: Diagnostic[],
): void {
  const decision = record.payload.judgment
  const caused = new Set<string>()
  if (!unique(decision.causes.map((cause) => cause.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats cause IDs'))
  const finalIds = new Set(decision.findings.map((finding) => finding.id))
  for (const cause of decision.causes) validateCause(cause, decision, finalIds, caused, diagnostics)
  const unassigned = new Set<string>()
  for (const item of decision.unassignedFindings) {
    const finding = decision.findings.find((entry) => entry.id === item.findingId)
    if (finding?.state !== 'unusable')
      diagnostics.push(diagnostic('invalid-unassigned-finding', `Unassigned finding ${item.findingId} is not unusable`))
    if (unassigned.has(item.findingId))
      diagnostics.push(diagnostic('duplicate-reference', `Unassigned finding ${item.findingId} is repeated`))
    unassigned.add(item.findingId)
  }
  for (const finding of decision.findings) {
    if (finding.state === 'usable' && !caused.has(finding.id))
      diagnostics.push(diagnostic('missing-cause', `Usable finding ${finding.id} is not assigned to a cause`))
    if (finding.state === 'unusable' && !unassigned.has(finding.id))
      diagnostics.push(
        diagnostic('missing-unassigned-finding', `Unusable finding ${finding.id} is not retained as unassigned`),
      )
  }
}

function validateCause(
  cause: Judgment['causes'][number],
  decision: Judgment,
  finalIds: Set<string>,
  caused: Set<string>,
  diagnostics: Diagnostic[],
): void {
  if (!causeSchema.safeParse(cause).success)
    diagnostics.push(diagnostic('malformed', `Cause ${cause.id} is incomplete`))
  if (!unique(cause.findingIds))
    diagnostics.push(diagnostic('duplicate-reference', `Cause ${cause.id} repeats a finding`))
  for (const findingId of cause.findingIds) {
    if (!finalIds.has(findingId))
      diagnostics.push(diagnostic('unknown-reference', `Cause ${cause.id} references unknown finding ${findingId}`))
    if (caused.has(findingId))
      diagnostics.push(diagnostic('duplicate-reference', `Finding ${findingId} belongs to more than one cause`))
    caused.add(findingId)
    const finding = decision.findings.find((entry) => entry.id === findingId)
    if (finding?.state === 'unusable')
      diagnostics.push(diagnostic('unusable-cause-member', `Unusable finding ${findingId} cannot belong to a cause`))
  }
}
