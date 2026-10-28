import { z } from 'zod'
import { contributionSchema, identifierSchema, type Json, jsonSchema, scopeSchema } from './record-values.ts'
import {
  type ReviewInterruptionPayload,
  type ReviewReplacementGrantPayload,
  reviewInterruptionPayloadSchema,
  reviewReplacementGrantPayloadSchema,
} from './review-interruption-schema.ts'
import {
  correctionResultSchema,
  debtReceiptSchema,
  decisionPayloadSchema,
  falsificationResultSchema,
  finalReviewSchema,
  fixRequestSchema,
  fixResultSchema,
  inventorySchema,
  stopSchema,
} from './review-schema.ts'
import { type SpecIdentityPayload, specIdentityPayloadSchema } from './uw-identity-schema.ts'
import {
  type MandatePayload,
  mandatePayloadSchema,
  type OperatorControlPayload,
  operatorControlPayloadSchema,
  type WorkflowBindingPayload,
  workflowBindingPayloadSchema,
} from './workflow-mandate-schema.ts'
import { type ActionReceiptPayload, actionReceiptPayloadSchema } from './workflow-receipt-schema.ts'

const envelope = {
  version: z.literal(1),
  recordId: identifierSchema,
  runId: identifierSchema,
  operationId: identifierSchema,
  inputs: z.array(identifierSchema),
}
const record = <K extends string, T extends z.ZodType>(kind: K, payload: T) =>
  scopeSchema.extend({ ...envelope, kind: z.literal(kind), payload }).strict()
export type CanonicalRecord = {
  [K in keyof PayloadByKind]: {
    repository: string
    target: string
    version: 1
    recordId: string
    runId: string
    operationId: string
    inputs: string[]
    kind: K
    payload: PayloadByKind[K]
  }
}[keyof PayloadByKind]
type PayloadByKind = {
  'review-attempt': z.infer<typeof inventorySchema>
  contribution: z.infer<typeof contributionSchema>
  decision: z.infer<typeof decisionPayloadSchema>
  review: z.infer<typeof finalReviewSchema>
  'fix-request': z.infer<typeof fixRequestSchema>
  'fix-result': z.infer<typeof fixResultSchema>
  'correction-result': z.infer<typeof correctionResultSchema>
  'falsification-result': z.infer<typeof falsificationResultSchema>
  'debt-receipt': z.infer<typeof debtReceiptSchema>
  stop: z.infer<typeof stopSchema>
  'epic-event': Json
  'spec-identity': SpecIdentityPayload
  mandate: MandatePayload
  'operator-control': OperatorControlPayload
  'action-receipt': ActionReceiptPayload
  'workflow-binding': WorkflowBindingPayload
  'review-interruption': ReviewInterruptionPayload
  'review-replacement-grant': ReviewReplacementGrantPayload
}
// The schema stays the runtime authority. Its inferred union is too large for TS to
// keep kind and payload paired, so the export type is the explicit pairing above.
export const recordSchema = z.discriminatedUnion('kind', [
  record('review-attempt', inventorySchema),
  record('contribution', contributionSchema),
  record('decision', decisionPayloadSchema),
  record('review', finalReviewSchema),
  record('fix-request', fixRequestSchema),
  record('fix-result', fixResultSchema),
  record('correction-result', correctionResultSchema),
  record('falsification-result', falsificationResultSchema),
  record('debt-receipt', debtReceiptSchema),
  record('stop', stopSchema),
  record('epic-event', jsonSchema),
  record('spec-identity', specIdentityPayloadSchema),
  record('mandate', mandatePayloadSchema),
  record('operator-control', operatorControlPayloadSchema),
  record('action-receipt', actionReceiptPayloadSchema),
  record('workflow-binding', workflowBindingPayloadSchema),
  record('review-interruption', reviewInterruptionPayloadSchema),
  record('review-replacement-grant', reviewReplacementGrantPayloadSchema),
]) as z.ZodType<CanonicalRecord>
export type Kind = CanonicalRecord['kind']
export type Payloads = {
  [K in Kind]: Extract<CanonicalRecord, { kind: K }>['payload']
}
