import { canonicalValueDigest } from './canonical-value.ts'
import { observationRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'
import type { AssessResultRecord } from './workflow-spec-assessment.ts'

type Constraint = SpecAssessment['compatibility']['examined'][number]

function citedConstraintsProblem(
  compatibility: SpecAssessment['compatibility'],
  expected: ReadonlySet<string>,
): string | null {
  if (compatibility.state === 'conflicting') {
    if (
      compatibility.conflicts.some(
        (conflict) =>
          !expected.has(canonicalValueDigest(conflict.left)) || !expected.has(canonicalValueDigest(conflict.right)),
      )
    )
      return 'Compatibility conflict cites a constraint outside the examined set'
  } else if (
    compatibility.state === 'undetermined' &&
    compatibility.constraints.some((constraint) => !expected.has(canonicalValueDigest(constraint)))
  ) {
    return 'Undetermined compatibility cites a constraint outside the examined set'
  }
  return null
}

function citationsProblem(
  record: AssessResultRecord,
  assessment: SpecAssessment,
  histories: readonly DecodedHistory[],
): string | null {
  const compatibility = assessment.compatibility
  const references =
    compatibility.state === 'conflicting'
      ? compatibility.conflicts.flatMap((conflict) => conflict.references)
      : compatibility.references
  const manifest = record.payload.inputs.manifest
  const pins = [
    ...manifest.repositoryReferences,
    ...manifest.plugin.files,
    ...manifest.expandedContext.filter((ref) => ref.source === 'git-file'),
  ]
  const available = [
    ...manifest.acceptedSources,
    ...manifest.deliveryData,
    ...manifest.expandedContext,
    ...record.payload.inputs.stageSources,
  ]
  for (const ref of references) {
    if (
      ref.source === 'record' &&
      !available.some(
        (candidate) =>
          candidate.source === 'record' &&
          candidate.selector === ref.selector &&
          candidate.digest === ref.digest &&
          canonicalValueDigest(candidate.record) === canonicalValueDigest(ref.record),
      )
    )
      return 'Compatibility citation was not captured in the assessment inputs'
    if (observationRefDiagnostics('compatibility', ref, histories, pins).length !== 0)
      return 'Compatibility citation is not authenticated'
  }
  return null
}

export function constraintExaminationProblem(
  constraints: readonly Constraint[],
  record: AssessResultRecord,
  assessment: SpecAssessment,
  histories: readonly DecodedHistory[],
): string | null {
  const expected = new Set(constraints.map(canonicalValueDigest))
  const examined = assessment.compatibility.examined.map(canonicalValueDigest)
  if (
    examined.length !== new Set(examined).size ||
    examined.length !== expected.size ||
    examined.some((key) => !expected.has(key))
  )
    return 'Compatibility examined set does not exactly cover the version-qualified constraints'
  return citedConstraintsProblem(assessment.compatibility, expected) ?? citationsProblem(record, assessment, histories)
}
