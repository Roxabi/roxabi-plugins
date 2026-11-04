import { z } from 'zod'
import { observationRefSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { diagnosticSchema, originalFindingSchema } from './record-values.ts'
import { causeJudgmentSchema, causeSchema, dispositionSchema, finalFindingSchema } from './review-schema.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { uwCreateInputSchema, writesSchema } from './uw-command-schema.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'
import { complexityFactorsSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { ownSpecRefSchema, specDraftSchema, specItemIdSchema, specSchema, uwTierSchema } from './uw-spec-schema.ts'

const ref = <K extends string>(kind: K) => externalRecordRefSchema.extend({ kind: z.literal(kind) })
const dispositionRef = ref('cause-disposition')
const operationRef = ref('cause-operation')
export const parentAdditionObservationSchema = z.strictObject({
  parent: scopeSchema,
  nativeDigest: sha256Schema,
  historyDigest: sha256Schema,
  state: z.enum(['inactive', 'active', 'indeterminate']),
  diagnostics: z.array(diagnosticSchema),
})
const sisterContextSchema = z.strictObject({
  kind: z.literal('sister'),
  disposition: dispositionRef,
  dispositionDigest: sha256Schema,
  original: scopeSchema,
  originalObservationDigest: sha256Schema,
  parent: scopeSchema.nullable(),
  parentObservation: parentAdditionObservationSchema.nullable(),
  relation: z.enum(['original-blocked-by-sister', 'sister-blocked-by-original']),
})
const promotionContextSchema = z.strictObject({
  kind: z.literal('report-promotion'),
  report: dispositionRef,
  reportDigest: sha256Schema,
  reason: z.string().trim().min(1),
  parentObservation: parentAdditionObservationSchema.nullable(),
})
export const creationContextSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('operator-create') }),
  sisterContextSchema,
  promotionContextSchema,
])
export type CreationContext = z.infer<typeof creationContextSchema>
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
export const causeSisterInputSchema = z.strictObject({
  disposition: dispositionRef,
  factors: complexityFactorsSchema,
  tierOverride: tierOverrideSchema,
  labels: z.strictObject({ add: z.array(z.string().min(1)), remove: z.array(z.string().min(1)) }),
})
export type CauseSisterInput = z.infer<typeof causeSisterInputSchema>
export const reportPromotionInputSchema = z.strictObject({
  report: dispositionRef,
  create: uwCreateInputSchema,
  reason: z.string().trim().min(1),
})
export type ReportPromotionInput = z.infer<typeof reportPromotionInputSchema>
export const causeCreationProposalSchema = z.strictObject({
  format: z.literal('omp-build-uw-proposal/1'),
  operationId: identifierSchema,
  operation: z.literal('create'),
  target: z.strictObject({ kind: z.literal('create'), repository: z.string().min(1) }),
  expected: z.null(),
  draft: specDraftSchema,
  allocation: z.strictObject({
    ledgerHead: z.null(),
    assignments: z.array(z.strictObject({ draftKey: identifierSchema, id: specItemIdSchema })),
    retirements: z.tuple([]),
    spec: specSchema,
  }),
  renderedBody: z.string(),
  title: z.string().min(1),
  factors: complexityFactorsSchema,
  tier: uwTierSchema,
  tierOverride: tierOverrideSchema,
  writes: writesSchema,
  normalization: z.tuple([]),
  assessment: z.null(),
  creation: z.discriminatedUnion('kind', [sisterContextSchema, promotionContextSchema]),
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
  format: z.literal('omp-build-cause-disposition/1'),
  origin: ownSpecRefSchema,
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
