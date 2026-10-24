import { z } from 'zod'

export const ompBuildStartReviewParametersSchema = z.strictObject({ pr: z.number().int().positive().optional() })
export type OmpBuildStartReviewParameters = z.infer<typeof ompBuildStartReviewParametersSchema>

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema)))
}

export const ompBuildStartReviewParametersJsonSchema = jsonSchema(ompBuildStartReviewParametersSchema)
