import { z } from 'zod'
import {
  identifierSchema,
  jsonSchema,
  labelSchema,
  policySchema,
  recallPlanSchema,
  sha256Schema,
  shaSchema,
  slotSchema,
} from './record-values.ts'

export const observedCommentSchema = z.strictObject({
  locator: z.string().min(1),
  nativeId: z.string().min(1).nullable(),
  body: z.string(),
  author: z.string().min(1).nullable(),
  createdAt: z.string().min(1).nullable(),
  updatedAt: z.string().min(1).nullable(),
})
export type ObservedComment = z.infer<typeof observedCommentSchema>
const selectedProofPartSchema = z.strictObject({
  id: z.number().int().positive(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export const reviewInputSnapshotSchema = z.strictObject({
  body: z.strictObject({ body: z.string(), lastEditedAt: z.string().nullable() }).nullable(),
  spec: z
    .strictObject({ reference: z.string().min(1), body: z.string(), lastEditedAt: z.string().nullable() })
    .nullable(),
  semctxParts: z.array(selectedProofPartSchema).nullable(),
  assertledgerParts: z.array(selectedProofPartSchema).nullable(),
})
export type ReviewInputSnapshot = z.infer<typeof reviewInputSnapshotSchema>
export const reviewSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pull-request') }),
  z.strictObject({ kind: z.literal('epic-range'), range: z.string().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) }),
])
export type ReviewSubject = z.infer<typeof reviewSubjectSchema>
const initialPullRequestInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('review'),
  tier: z.enum(['S', 'F-lite', 'F-full']),
  allocation: jsonSchema,
  policy: policySchema,
  subject: z.strictObject({ kind: z.literal('pull-request') }),
  inputSnapshot: reviewInputSnapshotSchema,
})
const initialEpicReviewInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('review'),
  tier: z.null(),
  allocation: jsonSchema,
  policy: policySchema,
  subject: z.strictObject({ kind: z.literal('epic-range'), range: z.string().regex(/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/) }),
  inputSnapshot: z.null(),
})
const initialCorrectionInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('initial'),
  purpose: z.literal('correction'),
  requestId: identifierSchema,
  policy: policySchema,
})
const recallInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('recall'),
  purpose: z.literal('review'),
  plan: recallPlanSchema,
  policy: policySchema,
})
const synthesisInventorySchema = z.strictObject({
  rootAttemptId: identifierSchema,
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  slots: z.array(slotSchema),
  stage: z.literal('synthesis'),
  purpose: z.enum(['review', 'correction']),
  policy: policySchema,
})
export const inventorySchema = z.union([
  initialPullRequestInventorySchema,
  initialEpicReviewInventorySchema,
  initialCorrectionInventorySchema,
  recallInventorySchema,
  synthesisInventorySchema,
])
export type Inventory = z.infer<typeof inventorySchema>

export const finalFindingSchema = z.discriminatedUnion('state', [
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('usable'),
    sourceFindingIds: z.array(identifierSchema).min(1),
    description: z.string().min(1),
    mergeReason: z.string().min(1).optional(),
  }),
  z.strictObject({
    id: identifierSchema,
    label: labelSchema.nullable(),
    impactReason: z.string().min(1),
    state: z.literal('unusable'),
    sourceFindingIds: z.tuple([identifierSchema]),
  }),
])
export type FinalFinding = z.infer<typeof finalFindingSchema>
export const causeSchema = z.strictObject({
  id: identifierSchema,
  title: z.string().min(1),
  mechanism: z.string().min(1),
  fix: z.string().min(1),
  failure: z.string().min(1),
  restored: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  proof: z.string().min(1),
  findingIds: z.array(identifierSchema).min(1),
  authorization: z.union([z.literal('required'), z.strictObject({ optionalNeighborOf: identifierSchema })]).optional(),
  admission: jsonSchema.optional(),
})
export type Cause = z.infer<typeof causeSchema>
export const standardsRowSchema = z.strictObject({ smell: z.string().min(1), assessment: z.string().min(1) })
export const reviewStandardsSchema = z.union([
  z.strictObject({ state: z.literal('ras') }),
  z.strictObject({ state: z.literal('observed'), rows: z.array(standardsRowSchema).min(1) }),
])
export type ReviewStandards = z.infer<typeof reviewStandardsSchema>
const reviewDecisionSchema = z.strictObject({
  purpose: z.literal('review'),
  policy: policySchema,
  sourceContributionIds: z.array(identifierSchema),
  findings: z.array(finalFindingSchema),
  causes: z.array(causeSchema),
  standards: reviewStandardsSchema.nullable(),
})
const correctionDecisionSchema = z.strictObject({
  purpose: z.literal('correction'),
  policy: policySchema,
  sourceContributionIds: z.array(identifierSchema),
  findings: z.array(finalFindingSchema),
  causes: z.array(causeSchema),
})
export const decisionSchema = z.discriminatedUnion('purpose', [reviewDecisionSchema, correctionDecisionSchema])
export type Decision = z.infer<typeof decisionSchema>
export const decisionPayloadSchema = z.strictObject({
  originalContributionId: identifierSchema,
  judgment: decisionSchema,
})

export const finalReviewSchema = z.strictObject({
  candidateGitSHA: shaSchema,
  input: sha256Schema.nullable(),
  inventoryIds: z.array(identifierSchema).min(1),
  decisionId: identifierSchema,
})
export type FinalReview = z.infer<typeof finalReviewSchema>
export const fixRequestSchema = z.strictObject({
  requestContributionId: identifierSchema,
  existingReviewId: identifierSchema.nullable(),
  scope: z.string().min(1),
  landing: z.literal(false),
})
export type FixRequest = z.infer<typeof fixRequestSchema>
export const correctionResultSchema = z.strictObject({
  decisionId: identifierSchema,
  causeId: identifierSchema,
  attempt: z.union([z.literal(1), z.literal(2)]),
  outcome: z.enum(['applied', 'failed', 'reverted', 'withdrawn']),
  commitSHAs: z.array(shaSchema),
  raw: jsonSchema,
})
export type CorrectionResult = z.infer<typeof correctionResultSchema>
export const falsificationResultSchema = z.strictObject({
  correctionResultId: identifierSchema,
  result: z.enum(['pass', 'fail', 'skipped']),
  notes: z.string(),
  raw: jsonSchema,
})
export type FalsificationResult = z.infer<typeof falsificationResultSchema>
export const debtReceiptSchema = z.strictObject({
  decisionId: identifierSchema,
  findingIds: z.array(identifierSchema),
  causeIds: z.array(identifierSchema),
  disposition: z.enum(['filed', 'deferred', 'retained']),
  target: z.string().nullable(),
  evidence: jsonSchema,
})
export type DebtReceipt = z.infer<typeof debtReceiptSchema>
export const fixResultSchema = z.strictObject({
  requestId: identifierSchema,
  decisionId: identifierSchema,
  candidateGitSHA: shaSchema,
  correctionResultIds: z.array(identifierSchema),
  falsificationResultIds: z.array(identifierSchema),
  debtReceiptIds: z.array(identifierSchema),
})
export type FixResult = z.infer<typeof fixResultSchema>
export const stopSchema = z.strictObject({
  reason: z.enum(['review-bound', 'ci-failed']),
  reviewId: identifierSchema,
  detail: jsonSchema,
})
export type Stop = z.infer<typeof stopSchema>
