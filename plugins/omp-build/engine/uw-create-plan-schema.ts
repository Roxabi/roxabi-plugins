import { z } from 'zod'
import { identifierSchema } from './schema-primitives.ts'
import { complexityFactorsSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { specDraftSchema, specItemIdSchema, specSchema, uwTierSchema } from './uw-spec-schema.ts'
import { writesSchema } from './uw-write-intent-schema.ts'

export const uwCreatePlanSchema = z.strictObject({
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
})
export type UwCreatePlan = z.infer<typeof uwCreatePlanSchema>
