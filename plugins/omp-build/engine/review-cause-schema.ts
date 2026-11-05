import { z } from 'zod'
import { observationRefSchema } from './criterion-evidence-schema.ts'
import { findingTargetSchema } from './finding-target-schema.ts'
import { identifierSchema, labelSchema } from './record-values.ts'
export const finalFindingSchema = z.discriminatedUnion('state', [
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('usable'),
    target: findingTargetSchema,
    sourceFindingIds: z.array(identifierSchema).min(1),
    description: z.string().min(1),
    mergeReason: z.string().min(1).optional(),
  }),
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('unusable'),
    target: findingTargetSchema.nullable(),
    sourceFindingIds: z.tuple([identifierSchema]),
  }),
])
export type FinalFinding = z.infer<typeof finalFindingSchema>
export const dispositionSchema = z.enum(['fix-original', 'sister-blocking', 'sister-after', 'report'])
export type Disposition = z.infer<typeof dispositionSchema>
export const citedJudgmentSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('supported'),
    value: z.boolean(),
    reason: z.string().trim().min(1),
    references: z.array(observationRefSchema).min(1),
  }),
  z.strictObject({
    state: z.enum(['missing', 'contested']),
    value: z.boolean().nullable(),
    reason: z.string(),
    references: z.array(observationRefSchema),
  }),
])
export const causeJudgmentSchema = z.strictObject({
  necessary: citedJudgmentSchema,
  urgent: citedJudgmentSchema,
  tooLarge: citedJudgmentSchema,
})
export type CauseJudgment = z.infer<typeof causeJudgmentSchema>
export const causeSchema = z.strictObject({
  id: identifierSchema,
  title: z.string().min(1),
  mechanism: z.string().min(1),
  fix: z.string().min(1),
  failure: z.string().min(1),
  restored: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  proof: z.string().min(1),
  findingIds: z.array(identifierSchema).min(1),
  judgment: causeJudgmentSchema,
  proposedDisposition: dispositionSchema.nullable(),
})
export type Cause = z.infer<typeof causeSchema>
