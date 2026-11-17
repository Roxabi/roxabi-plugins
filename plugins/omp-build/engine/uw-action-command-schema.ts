import { z } from 'zod'
import { pinnedFileRefSchema, recordInputRefSchema } from './action-input-refs.ts'
import { actionInputsSchema, actionPurposeSchema, actionSubjectSchema } from './action-input-schema.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
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
export const actionEnvelopeSchema = z.union([
  z.strictObject({ request: actionRequestSchema }),
  z.strictObject({
    request: actionRequestSchema,
    reviewed: actionInputsSchema,
    intent: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('prepublication') }),
      z.strictObject({ kind: z.literal('persisted'), start: externalRecordRefSchema }),
    ]),
  }),
])
