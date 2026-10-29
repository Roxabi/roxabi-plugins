import { z } from 'zod'
import { scopeSchema } from './schema-primitives.ts'
import { criterionIdSchema, invariantIdSchema, ownSpecRefSchema } from './uw-spec-schema.ts'

export const FINDING_TARGET_FORMAT = 'omp-build-finding-target/1' as const

const formatSchema = z.literal(FINDING_TARGET_FORMAT)
export const criterionTargetSchema = z.strictObject({
  format: formatSchema,
  kind: z.literal('criterion'),
  spec: ownSpecRefSchema,
  id: criterionIdSchema,
})
export const findingTargetSchema = z.discriminatedUnion('kind', [
  criterionTargetSchema,
  z.strictObject({
    format: formatSchema,
    kind: z.literal('invariant'),
    spec: ownSpecRefSchema,
    id: invariantIdSchema,
  }),
  z.strictObject({
    format: formatSchema,
    kind: z.literal('outside-spec'),
    uw: scopeSchema,
    element: z.string().min(1),
  }),
])
export type FindingTarget = z.infer<typeof findingTargetSchema>
export type CriterionTarget = z.infer<typeof criterionTargetSchema>
