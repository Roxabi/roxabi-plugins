import { z } from 'zod'
import { gitObjectIdSchema } from './record-references.ts'

export const codeRangeSchema = z.strictObject({
  repository: z.string().min(1),
  base: gitObjectIdSchema,
  head: gitObjectIdSchema,
  referenceCommit: gitObjectIdSchema,
})
export type CodeRange = z.infer<typeof codeRangeSchema>
