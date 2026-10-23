import { z } from 'zod'
import { recordSchema } from './record-schema.ts'
import { diagnosticSchema, scopeSchema } from './record-values.ts'
import { observedCommentSchema } from './review-schema.ts'

export const historySchema = z.strictObject({
  scope: scopeSchema,
  expectedAuthor: z.string().min(1),
  stopAuthor: z.string().min(1).nullable(),
  complete: z.boolean(),
  comments: z.array(observedCommentSchema),
  diagnostics: z.array(diagnosticSchema),
})
export type History = z.infer<typeof historySchema>
export const operationAuthoritySchema = z.enum(['authority', 'foreign', 'accounted'])
export type OperationAuthority = z.infer<typeof operationAuthoritySchema>
export const operationReadSchema = z.strictObject({
  operationId: z.string().min(1).nullable(),
  recordId: z.string().min(1).nullable(),
  kind: z.string().min(1).nullable(),
  status: z.enum(['complete', 'incomplete', 'conflict', 'invalid', 'legacy']),
  parts: z.array(observedCommentSchema),
  record: recordSchema.nullable(),
  claimedKinds: z
    .array(z.string().min(1))
    .refine((kinds) => new Set(kinds).size === kinds.length, 'claimed kinds must be distinct'),
  authority: operationAuthoritySchema,
})
export type OperationRead = z.infer<typeof operationReadSchema>
export const decodedHistorySchema = z.strictObject({
  source: historySchema,
  operations: z.array(operationReadSchema),
  diagnostics: z.array(diagnosticSchema),
})
export type DecodedHistory = z.infer<typeof decodedHistorySchema>
