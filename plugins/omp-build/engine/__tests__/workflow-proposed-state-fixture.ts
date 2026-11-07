import { specDigest } from '../record-digests.ts'
import { canonicalSpec, type SpecSnapshot } from '../uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../uw-spec-schema.ts'
import type {
  AssessmentState,
  ProposedAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'

type ProposedStateInput = Parameters<typeof proposedAssessmentState>[1]
function snapshot(input: ProposedStateInput, reference: string): SpecSnapshot {
  const content = input.content ?? {
    criteria: [{ id: 'C1' as const, statement: input.body }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  }
  const canonical = canonicalSpec({ format: SPEC_CONTENT_FORMAT, ...content })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  return {
    spec: canonical.value,
    raw: {
      reference,
      body: input.body,
      bodySha256: specDigest(input.body),
      lastEditedAt: '2026-10-21T00:00:00Z',
    },
  }
}
export function makeProposedAssessmentState(
  accepted: AssessmentState,
  input: ProposedStateInput,
): ProposedAssessmentState {
  const nextSnapshot = snapshot(input, accepted.snapshot.raw.reference)
  const children = input.children ?? accepted.children
  const [firstChild, ...remainingChildren] = children
  const childSubject = (child: ProposedAssessmentState['children'][number]) =>
    'kind' in child ? { kind: 'created-by' as const, operationId: child.operationId } : child.scope
  const coverage: ProposedAssessmentState['coverage'] =
    firstChild === undefined
      ? null
      : {
          parent: { uw: accepted.ref.uw, version: nextSnapshot.spec.version },
          assignments: nextSnapshot.spec.criteria.map((criterion) => ({
            criterion: criterion.id,
            children: [childSubject(firstChild), ...remainingChildren.map(childSubject)],
          })),
        }
  return {
    snapshot: nextSnapshot,
    tier: input.tier ?? accepted.tier,
    children,
    inheritedOwnSpecRefs: accepted.inheritedOwnSpecRefs,
    coverage,
  }
}
