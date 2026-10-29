import { z } from 'zod'
import { pinnedFileRefSchema, recordInputRefSchema } from './action-input-refs.ts'
import { actionInputsSchema, actionPurposeSchema, actionSubjectSchema } from './action-input-schema.ts'
import { gitObjectIdSchema } from './record-references.ts'
import { actionOperandsSchema, refineActionOperands } from './workflow-action-operands.ts'

export const actionRequestSchema = z
  .strictObject({
    actionId: z.string().min(1),
    purpose: actionPurposeSchema,
    subject: actionSubjectSchema,
    operands: actionOperandsSchema.optional(),
    code: z.strictObject({
      repository: z.string().min(1),
      base: gitObjectIdSchema,
      head: gitObjectIdSchema,
      referenceCommit: gitObjectIdSchema,
    }),
    stageSources: z.array(recordInputRefSchema),
    expandedContext: z.array(z.union([recordInputRefSchema, pinnedFileRefSchema])),
  })
  .superRefine(refineActionOperands)
export const actionEnvelopeSchema = z.strictObject({
  request: actionRequestSchema,
  reviewed: actionInputsSchema.optional(),
})
