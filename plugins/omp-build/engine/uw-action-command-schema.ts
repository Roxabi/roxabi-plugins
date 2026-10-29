import { z } from 'zod'
import {
  actionInputsSchema,
  actionPurposeSchema,
  actionSubjectSchema,
  pinnedFileRefSchema,
  recordInputRefSchema,
} from './action-input-schema.ts'
import { gitObjectIdSchema } from './record-references.ts'

export const actionRequestSchema = z.strictObject({
  actionId: z.string().min(1),
  purpose: actionPurposeSchema,
  subject: actionSubjectSchema,
  code: z.strictObject({
    repository: z.string().min(1),
    base: gitObjectIdSchema,
    head: gitObjectIdSchema,
    referenceCommit: gitObjectIdSchema,
  }),
  stageSources: z.array(recordInputRefSchema),
  expandedContext: z.array(z.union([recordInputRefSchema, pinnedFileRefSchema])),
})
export const actionEnvelopeSchema = z.strictObject({
  request: actionRequestSchema,
  reviewed: actionInputsSchema.optional(),
})
