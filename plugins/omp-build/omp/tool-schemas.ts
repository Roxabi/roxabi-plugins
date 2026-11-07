import { z } from 'zod'
import { framingFormInputSchema } from '../engine/framing-form-schema.ts'

export const ompBuildStartReviewParametersSchema = z.strictObject({ pr: z.number().int().positive().optional() })
export type OmpBuildStartReviewParameters = z.infer<typeof ompBuildStartReviewParametersSchema>

export const ompBuildRecoveryPrParametersSchema = z.strictObject({ pr: z.number().int().positive() })
export type OmpBuildRecoveryPrParameters = z.infer<typeof ompBuildRecoveryPrParametersSchema>

export const ompBuildRecoveryReplaceParametersSchema = z.strictObject({ pr: z.number().int().positive() })
export type OmpBuildRecoveryReplaceParameters = z.infer<typeof ompBuildRecoveryReplaceParametersSchema>

export const ompBuildPrepareCheckoutParametersSchema = z.strictObject({
  reference: z.string().trim().min(1),
})
export type OmpBuildPrepareCheckoutParameters = z.infer<typeof ompBuildPrepareCheckoutParametersSchema>

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema)))
}

export const ompBuildStartReviewParametersJsonSchema = jsonSchema(ompBuildStartReviewParametersSchema)
export const ompBuildRecoveryPrParametersJsonSchema = jsonSchema(ompBuildRecoveryPrParametersSchema)
export const ompBuildRecoveryReplaceParametersJsonSchema = jsonSchema(ompBuildRecoveryReplaceParametersSchema)
export const ompBuildPrepareCheckoutParametersJsonSchema = jsonSchema(ompBuildPrepareCheckoutParametersSchema)
/** Read-only framing form submission; runtime parsing uses the facade's `framingFormInputSchema`. */
export const ompBuildFramingSubmitParametersJsonSchema = jsonSchema(framingFormInputSchema)
