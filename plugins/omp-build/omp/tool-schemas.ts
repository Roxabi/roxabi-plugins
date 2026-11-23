import { z } from 'zod'
import { framingFormInputSchema } from '../engine/framing-form-schema.ts'

export const ompBuildPrepareCheckoutParametersSchema = z.strictObject({
  reference: z.string().trim().min(1),
})
export type OmpBuildPrepareCheckoutParameters = z.infer<typeof ompBuildPrepareCheckoutParametersSchema>

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema)))
}

export const ompBuildPrepareCheckoutParametersJsonSchema = jsonSchema(ompBuildPrepareCheckoutParametersSchema)
/** Read-only framing form submission; runtime parsing uses the facade's `framingFormInputSchema`. */
export const ompBuildFramingSubmitParametersJsonSchema = jsonSchema(framingFormInputSchema)
