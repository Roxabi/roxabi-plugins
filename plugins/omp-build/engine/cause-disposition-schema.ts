import { z } from 'zod'
import { recordInputRefSchema } from './action-input-refs.ts'
import { causeCreationContextSchema } from './cause-creation-context-schema.ts'

export {
  type CreationContext,
  creationContextSchema,
  parentAdditionObservationSchema,
} from './cause-creation-context-schema.ts'

import { observationRefSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { diagnosticSchema, originalFindingSchema } from './record-values.ts'
import { causeJudgmentSchema, causeSchema, dispositionSchema, finalFindingSchema } from './review-schema.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { uwCreateInputSchema } from './uw-command-schema.ts'
import { uwCreatePlanSchema } from './uw-create-plan-schema.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'
import { complexityFactorsSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { criterionIdSchema, ownSpecRefSchema } from './uw-spec-schema.ts'
import { assessSpecExactSchema, createdChildSlotSchema } from './workflow-action-operands.ts'

const ref = <K extends string>(kind: K) => externalRecordRefSchema.extend({ kind: z.literal(kind) })
const dispositionRef = ref('cause-disposition')
const operationRef = ref('cause-operation')
export const causeAdjudicationInputSchema = z.strictObject({
  pending: dispositionRef,
  rejectedFindingIds: z.array(identifierSchema),
  judgment: causeJudgmentSchema.nullable(),
  reason: z.string().trim().min(1),
  references: z.array(observationRefSchema),
})
export type CauseAdjudicationInput = z.infer<typeof causeAdjudicationInputSchema>
export const causeAdjudicationProposalSchema = causeAdjudicationInputSchema.extend({
  format: z.literal('omp-build-cause-adjudication-proposal/1'),
  operationId: identifierSchema,
  operation: z.literal('adjudicate-cause'),
  uw: scopeSchema,
  pendingDigest: sha256Schema,
})
export type CauseAdjudicationProposal = z.infer<typeof causeAdjudicationProposalSchema>
/** Command-only planned child placeholder; it is replaced with the actual operation ID before assessment. */
export const parentCoverageIntentSchema = z.strictObject({
  parent: z.strictObject({ uw: scopeSchema, version: sha256Schema }),
  assignments: z.array(
    z.strictObject({
      criterion: criterionIdSchema,
      children: z
        .tuple([z.union([scopeSchema, z.strictObject({ kind: z.literal('created-child') })])])
        .rest(z.union([scopeSchema, z.strictObject({ kind: z.literal('created-child') })])),
    }),
  ),
})
export type ParentCoverageIntent = z.infer<typeof parentCoverageIntentSchema>
export const causeSisterInputSchema = z.strictObject({
  disposition: dispositionRef,
  factors: complexityFactorsSchema,
  tierOverride: tierOverrideSchema,
  labels: z.strictObject({ add: z.array(z.string().min(1)), remove: z.array(z.string().min(1)) }),
  parentCoverage: parentCoverageIntentSchema.nullable().optional(),
})
export type CauseSisterInput = z.infer<typeof causeSisterInputSchema>
export const reportPromotionInputSchema = z.strictObject({
  report: dispositionRef,
  create: uwCreateInputSchema,
  reason: z.string().trim().min(1),
  parentCoverage: parentCoverageIntentSchema.nullable().optional(),
})
export type ReportPromotionInput = z.infer<typeof reportPromotionInputSchema>
export const composedParentConsentSchema = z.strictObject({
  parent: scopeSchema,
  mandate: ref('mandate'),
  accepted: ownSpecRefSchema,
  predecessor: externalRecordRefSchema,
  versionVector: z.tuple([ownSpecRefSchema]).rest(ownSpecRefSchema),
  nativeObservationDigest: sha256Schema,
  historyDigest: sha256Schema,
  assessment: ref('action-receipt'),
  exactInputs: assessSpecExactSchema,
  slot: createdChildSlotSchema,
  parentOperationId: identifierSchema,
  parentProposalDigest: sha256Schema,
})
export type ComposedParentConsent = z.infer<typeof composedParentConsentSchema>
export const causeCreationProposalSchema = uwCreatePlanSchema.extend({
  creation: causeCreationContextSchema,
  parentAcceptance: composedParentConsentSchema.nullable(),
})
export type CauseCreationProposal = z.infer<typeof causeCreationProposalSchema>
export const causeOperationPayloadSchema = z.strictObject({
  format: z.literal('omp-build-cause-operation/1'),
  proposal: z.union([causeAdjudicationProposalSchema, causeCreationProposalSchema]),
  proposalDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
})
export type CauseOperationPayload = z.infer<typeof causeOperationPayloadSchema>
export const causeDispositionPayloadSchema = z.strictObject({
  format: z.literal('omp-build-cause-disposition/2'),
  origin: ownSpecRefSchema,
  basis: z.strictObject({
    versionVector: z.tuple([ownSpecRefSchema]).rest(ownSpecRefSchema),
    capture: recordInputRefSchema.nullable(),
  }),
  subject: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('cause'),
      decision: ref('decision'),
      cause: causeSchema,
      findings: z.array(finalFindingSchema),
    }),
    z.strictObject({
      kind: z.literal('retained-finding'),
      contribution: ref('contribution'),
      finding: originalFindingSchema,
      diagnostics: z.array(diagnosticSchema),
    }),
    z.strictObject({ kind: z.literal('rule-error'), source: externalRecordRefSchema, diagnostic: diagnosticSchema }),
  ]),
  previous: dispositionRef.nullable(),
  adjudication: operationRef.nullable(),
  outcome: z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('final'),
      disposition: dispositionSchema,
      blocking: z.boolean(),
      reason: z.string().min(1),
    }),
    z.strictObject({ state: z.literal('pending-blocking'), reason: z.string().min(1) }),
  ]),
  diagnostics: z.array(diagnosticSchema),
})
export type CauseDispositionPayload = z.infer<typeof causeDispositionPayloadSchema>
export const reportPromotionPayloadSchema = z.strictObject({
  format: z.literal('omp-build-report-promotion/1'),
  report: dispositionRef,
  operation: operationRef,
  created: scopeSchema,
  identity: ref('spec-identity'),
})
export type ReportPromotionPayload = z.infer<typeof reportPromotionPayloadSchema>
