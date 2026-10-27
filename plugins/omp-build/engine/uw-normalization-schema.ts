import { z } from 'zod'
import { specDraftSchema, specItemIdSchema, uwTierSchema } from './uw-spec-schema.ts'

const positionSchema = z.strictObject({ line: z.number().int().positive(), column: z.number().int().positive() })
export const sourceSpanSchema = z.strictObject({ start: positionSchema, end: positionSchema })
export const draftTextRangeSchema = z
  .strictObject({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
  .refine((range) => range.start < range.end, 'Draft text ranges must be non-empty and half-open')
const normalizationTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), id: specItemIdSchema }),
  z.strictObject({ kind: z.literal('new'), draftKey: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('section'),
    section: z.enum(['origin', 'context', 'change']),
    range: draftTextRangeSchema,
  }),
  z.strictObject({ kind: z.literal('exclusion'), index: z.number().int().nonnegative(), range: draftTextRangeSchema }),
  z.strictObject({
    kind: z.literal('open-question'),
    index: z.number().int().nonnegative(),
    range: draftTextRangeSchema,
  }),
])
export const normalizationDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('kept'), source: sourceSpanSchema, target: normalizationTargetSchema }),
  z.strictObject({
    kind: z.literal('reworded'),
    source: sourceSpanSchema,
    target: normalizationTargetSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('new'),
    target: z.strictObject({ kind: z.literal('new'), draftKey: z.string().min(1) }),
    reason: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('removed'), source: sourceSpanSchema, reason: z.string().min(1) }),
])
export type NormalizationDecision = z.infer<typeof normalizationDecisionSchema>

export const complexityFactorsSchema = z.strictObject({
  files: z.number().int().min(1).max(10),
  risk: z.number().int().min(1).max(10),
  architecture: z.number().int().min(1).max(10),
  unknowns: z.number().int().min(1).max(10),
  domains: z.number().int().min(1).max(10),
})
export type NormalizationFactors = z.infer<typeof complexityFactorsSchema>

export const tierOverrideSchema = z.strictObject({ tier: uwTierSchema, reason: z.string().min(1) }).nullable()

/** Native proposal output: targets may name existing C/I ids or new draft slots; engine allocation owns fresh identities. */
export const normalizationJudgementSchema = z.strictObject({
  draft: specDraftSchema,
  normalization: z.array(normalizationDecisionSchema),
  factors: complexityFactorsSchema,
  tierOverride: tierOverrideSchema,
})
export type NormalizationJudgement = z.infer<typeof normalizationJudgementSchema>
