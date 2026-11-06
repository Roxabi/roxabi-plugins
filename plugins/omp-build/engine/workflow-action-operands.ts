import { z } from 'zod'
import { causeCreationContextSchema } from './cause-creation-context-schema.ts'
import { failedCheckEvidenceDigest, failedCheckFailureSchema } from './record-digests.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, scopeSchema, sha256Schema, shaSchema } from './schema-primitives.ts'
import { uwCreatePlanSchema } from './uw-create-plan-schema.ts'
import { nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import {
  criterionIdSchema,
  ownSpecRefSchema,
  specItemIdSchema,
  specSnapshotSchema,
  uwTierSchema,
} from './uw-spec-schema.ts'
import { refineAssessmentProposal } from './workflow-assessment-operands-refinement.ts'
import { acceptedChildCommitmentSchema, parentCoverageSchema, refineParentCoverage } from './workflow-mandate-schema.ts'

const assessedOwnStateSchema = z.strictObject({
  snapshot: specSnapshotSchema,
  tier: uwTierSchema,
  children: z.array(acceptedChildCommitmentSchema),
  inheritedOwnSpecRefs: z.array(ownSpecRefSchema),
  coverage: parentCoverageSchema.nullable(),
})
export const createdChildSlotSchema = z.strictObject({ kind: z.literal('created-by'), operationId: z.string().min(1) })
export const plannedChildSchema = createdChildSlotSchema.extend({ plan: uwCreatePlanSchema, planDigest: sha256Schema })
const childSubjectSchema = z.union([scopeSchema, createdChildSlotSchema])
export const proposedParentCoverageSchema = z.strictObject({
  parent: z.strictObject({ uw: scopeSchema, version: sha256Schema }),
  assignments: z.array(
    z.strictObject({ criterion: criterionIdSchema, children: z.tuple([childSubjectSchema]).rest(childSubjectSchema) }),
  ),
})
export const proposedAssessmentStateSchema = assessedOwnStateSchema.extend({
  children: z.array(z.union([acceptedChildCommitmentSchema, plannedChildSchema])),
  coverage: proposedParentCoverageSchema.nullable(),
})
export type ProposedAssessmentState = z.infer<typeof proposedAssessmentStateSchema>
const mechanicalSpecDeltaSchema = z.strictObject({
  added: z.array(specItemIdSchema),
  removed: z.array(specItemIdSchema),
  changedStatements: z.array(specItemIdSchema),
  exclusionsChanged: z.boolean(),
  tierChanged: z.boolean(),
  childrenChanged: z.boolean(),
  inheritanceChanged: z.boolean(),
  coverageChanged: z.boolean(),
  sectionsOrOrderChanged: z.boolean(),
})
const assessSpecExactBaseSchema = z.strictObject({
  format: z.literal('omp-build-spec-assessment/3'),
  accepted: assessedOwnStateSchema.extend({ ref: ownSpecRefSchema }),
  proposed: proposedAssessmentStateSchema,
  attachedChildren: z.array(acceptedChildCommitmentSchema),
  attachedWayfinders: z.array(nativeIssueObservationSchema),
  childOwnSources: z.array(z.strictObject({ uw: scopeSchema, own: ownSpecRefSchema.nullable() })),
  identityAllocations: z.array(externalRecordRefSchema),
  mechanical: mechanicalSpecDeltaSchema,
})
export type AssessmentOperandsValue = z.infer<typeof assessSpecExactBaseSchema>
export const assessSpecExactSchema = assessSpecExactBaseSchema.superRefine((value, context) => {
  refineParentCoverage(
    {
      own: {
        uw: value.accepted.ref.uw,
        version: value.accepted.snapshot.spec.version,
        snapshot: value.accepted.snapshot,
      },
      children: value.accepted.children,
      coverage: value.accepted.coverage,
    },
    context,
  )
  refineAssessmentProposal(value, context)
})
export type AssessSpecExact = z.infer<typeof assessSpecExactSchema>

export const ciExactSchema = z
  .strictObject({
    candidateGitSHA: shaSchema,
    scope: scopeSchema,
    failedChecks: z.array(z.string().min(1)),
    evidenceDigest: sha256Schema,
    failures: z.array(failedCheckFailureSchema).min(1),
  })
  .superRefine((value, context) => {
    const digest = failedCheckEvidenceDigest(value)
    if (digest === null || digest !== value.evidenceDigest) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceDigest'],
        message: 'evidence digest does not match the native check identity',
      })
    }
  })
export type CiExact = z.infer<typeof ciExactSchema>
export const integrationExactSchema = z.strictObject({ mandateId: identifierSchema, planActionId: identifierSchema })
export type IntegrationExact = z.infer<typeof integrationExactSchema>
export const assessmentProposalOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native-current') }),
  z.strictObject({ kind: z.literal('cause-created-child'), creation: causeCreationContextSchema }),
])
export type AssessmentProposalOrigin = z.infer<typeof assessmentProposalOriginSchema>

export const actionOperandsSchema = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('assess-spec'),
      origin: assessmentProposalOriginSchema,
      exactInputs: assessSpecExactSchema,
    }),
    z.strictObject({ action: z.literal('attribute-ci'), exactInputs: ciExactSchema }),
    z.strictObject({ action: z.literal('integrate'), exactInputs: integrationExactSchema }),
  ])
  .superRefine((value, context) => {
    if (value.action !== 'assess-spec') return
    const slots = value.exactInputs.proposed.children.filter((child) => 'kind' in child)
    if (value.origin.kind === 'native-current' && slots.length !== 0)
      context.addIssue({
        code: 'custom',
        path: ['origin'],
        message: 'native-current assessment cannot contain a planned child slot',
      })
    if (value.origin.kind === 'cause-created-child' && slots.length !== 1)
      context.addIssue({
        code: 'custom',
        path: ['origin'],
        message: 'cause-created-child assessment requires exactly one planned child slot',
      })
  })
export type ActionOperands = z.infer<typeof actionOperandsSchema>

export function refineActionOperands(
  value: { purpose: string; operands?: ActionOperands },
  context: z.RefinementCtx,
): void {
  if (value.purpose === 'assess-spec' || value.purpose === 'attribute-ci' || value.purpose === 'integrate') {
    if (value.operands?.action !== value.purpose) {
      context.addIssue({ code: 'custom', path: ['operands'], message: 'purpose requires matching action operands' })
    }
  } else if (value.operands !== undefined) {
    context.addIssue({ code: 'custom', path: ['operands'], message: 'operands are not allowed for this purpose' })
  }
}
