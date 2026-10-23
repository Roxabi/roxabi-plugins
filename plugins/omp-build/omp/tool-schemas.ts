import { z } from 'zod'

export const ompBuildStartReviewParametersSchema = z.strictObject({ pr: z.number().int().positive().optional() })
export type OmpBuildStartReviewParameters = z.infer<typeof ompBuildStartReviewParametersSchema>
export const ompBuildStartFixParametersSchema = z.strictObject({
  reference: z.string().min(1).optional(),
  reviewId: z.string().min(1).optional(),
})
export type OmpBuildStartFixParameters = z.infer<typeof ompBuildStartFixParametersSchema>

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema)))
}

export const ompBuildStartReviewParametersJsonSchema = jsonSchema(ompBuildStartReviewParametersSchema)
export const ompBuildStartFixParametersJsonSchema = jsonSchema(ompBuildStartFixParametersSchema)
