import { z } from 'zod'
import { REVIEW_INPUT_FORMAT } from './record-format.ts'
import { type ExternalRecordRef, externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, sha256Schema, shaSchema } from './record-values.ts'

const workflowBindingRefSchema = externalRecordRefSchema.extend({ kind: z.literal('workflow-binding') })
type WorkflowBindingRef = ExternalRecordRef & { kind: 'workflow-binding' }

export const reviewInterruptionPayloadSchema = z.strictObject({
  rootAttemptId: identifierSchema,
  historicalBinding: workflowBindingRefSchema,
})
export type ReviewInterruptionPayload = {
  rootAttemptId: string
  historicalBinding: WorkflowBindingRef
}

export const reviewReplacementGrantPayloadSchema = z.strictObject({
  rootAttemptId: identifierSchema,
  dispositionId: identifierSchema,
  candidateGitSHA: shaSchema,
  inputFormat: z.literal(REVIEW_INPUT_FORMAT),
  input: sha256Schema,
  binding: workflowBindingRefSchema,
})
export type ReviewReplacementGrantPayload = {
  rootAttemptId: string
  dispositionId: string
  candidateGitSHA: string
  inputFormat: typeof REVIEW_INPUT_FORMAT
  input: string
  binding: WorkflowBindingRef
}
