import { z } from 'zod'

export const jsonSchema = z.json()
export type Json = z.infer<typeof jsonSchema>
export const diagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  recordId: z.string().min(1).optional(),
  operationId: z.string().min(1).optional(),
  findingId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  detail: jsonSchema.optional(),
})
export type Diagnostic = z.infer<typeof diagnosticSchema>
export const identifierSchema = z.string().min(1)
export const shaSchema = z.string().min(1)
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
export const scopeSchema = z.strictObject({ repository: z.string(), target: z.string() })
export type Scope = z.infer<typeof scopeSchema>
export const repoRelativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?![A-Za-z]:\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\r\n\\]+$/)
