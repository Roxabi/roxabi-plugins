import { z } from 'zod'
import { causeDependencyNativePlanSchema } from './cause-dependency-adjustment-schema.ts'
import { observationRefSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { scopeSchema, sha256Schema } from './record-values.ts'
import { complexityFactorsSchema, normalizationDecisionSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { specDraftSchema } from './uw-spec-schema.ts'
import { repositorySchema, writesSchema } from './uw-write-intent-schema.ts'

export { writesSchema } from './uw-write-intent-schema.ts'

const shared = {
  draft: specDraftSchema,
  title: z.string().min(1),
  factors: complexityFactorsSchema,
  writes: writesSchema,
  normalization: z.array(normalizationDecisionSchema),
  tierOverride: tierOverrideSchema,
}

/** Strict untrusted CLI JSON schemas; the host imports these only through dist/contracts.js. */
export const uwProposalInputSchema = z.strictObject({ uw: scopeSchema, sourceBodySha256: sha256Schema, ...shared })
export const uwCreateInputSchema = z.strictObject({ repository: repositorySchema, ...shared })
export type UwProposalInputJson = z.infer<typeof uwProposalInputSchema>
export type UwCreateInputJson = z.infer<typeof uwCreateInputSchema>

/** Decision inputs only: observed facts and execution readback are supplied by the host. */
export const causeDependencyAdjustmentInputSchema = z.strictObject({
  origin: scopeSchema,
  disposition: externalRecordRefSchema.extend({ kind: z.literal('cause-disposition') }),
  receipt: externalRecordRefSchema.extend({ kind: z.literal('debt-receipt') }),
  predecessor: z.union([
    externalRecordRefSchema.extend({ kind: z.literal('debt-receipt') }),
    externalRecordRefSchema.extend({ kind: z.literal('operator-control') }),
  ]),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('withdraw') }),
    z.strictObject({ kind: z.literal('replace'), blocker: scopeSchema }),
  ]),
  nativeEffect: causeDependencyNativePlanSchema,
  reason: z.string().trim().min(1),
  references: z.array(observationRefSchema),
})
export type CauseDependencyAdjustmentInputJson = z.infer<typeof causeDependencyAdjustmentInputSchema>
