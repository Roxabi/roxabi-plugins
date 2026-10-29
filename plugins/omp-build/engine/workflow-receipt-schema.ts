import { z } from 'zod'
import { missingContextOutputSchema } from './action-context.ts'
import { actionInputsSchema } from './action-input-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { diagnosticSchema, identifierSchema, nativeOutcomeSchema } from './record-values.ts'
import { normalizationJudgementSchema } from './uw-normalization-schema.ts'

import {
  ciAttributionSchema,
  implementationOutputSchema,
  planOutputSchema,
  producerImplementationOutputSchema,
  specAssessmentSchema,
} from './workflow-output-schema.ts'
import {
  type AssessSpecExact,
  assessSpecExactSchema,
  ciExactSchema,
  declaredPlanSlots,
  frameExactSchema,
  type HostEffectAdmission,
  hostEffectAdmissionSchema,
  type ImplementationAdmissionCommand,
  implementationAdmissionCommandSchema,
  implementExactSchema,
  nestedPlanContributionSchema,
  normalizeExactSchema,
  PLAN_REVIEW_SPECIALISTS,
  type PlanReviewSlot,
  planExactSchema,
  planReviewExactSchema,
  planReviewSlotSchema,
  planReviewSpecialistSchema,
  preMandateFrameExactSchema,
  refineActionReceipt,
} from './workflow-receipt-exact.ts'

export {
  type AssessSpecExact,
  assessSpecExactSchema,
  type HostEffectAdmission,
  hostEffectAdmissionSchema,
  type ImplementationAdmissionCommand,
  implementationAdmissionCommandSchema,
  PLAN_REVIEW_SPECIALISTS,
  type PlanReviewSlot,
  planReviewSlotSchema,
  planReviewSpecialistSchema,
}

export const ACTION_RECEIPT_FORMAT = 'omp-build-action-receipt/2' as const
export const workflowReceiptActionSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'plan-review',
  'implement',
  'attribute-ci',
  'normalize',
])
export type WorkflowReceiptAction = z.infer<typeof workflowReceiptActionSchema>
export const preMandateRefSchema = z.strictObject({
  kind: z.literal('absent'),
  reason: z.literal('pre-mandate'),
})
export type PreMandateRef = z.infer<typeof preMandateRefSchema>

function actionReceipt<A extends WorkflowReceiptAction, E extends z.ZodType, S extends z.ZodType, M extends z.ZodType>(
  action: A,
  exact: E,
  structured: S,
  mandate: M,
) {
  return [
    z.strictObject({
      format: z.literal(ACTION_RECEIPT_FORMAT),
      phase: z.literal('start'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate,
      inputs: actionInputsSchema,
      exactInputs: exact,
    }),
    z.strictObject({
      format: z.literal(ACTION_RECEIPT_FORMAT),
      phase: z.literal('result'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate,
      inputs: actionInputsSchema,
      start: externalRecordRefSchema,
      exactInputs: exact,
      native: nativeOutcomeSchema,
      structured: structured.nullable(),
      admission: hostEffectAdmissionSchema.nullable(),
      diagnostics: z.array(diagnosticSchema),
    }),
  ] as const
}

const mandated = externalRecordRefSchema
const [frameStart, frameResult] = actionReceipt('frame', frameExactSchema, missingContextOutputSchema, mandated)
const [frameUnmandatedStart, frameUnmandatedResult] = actionReceipt(
  'frame',
  preMandateFrameExactSchema,
  missingContextOutputSchema,
  preMandateRefSchema,
)
const [assessStart, assessResult] = actionReceipt(
  'assess-spec',
  assessSpecExactSchema,
  z.union([specAssessmentSchema, missingContextOutputSchema]),
  mandated,
)
const [planStart, planResult] = actionReceipt(
  'plan',
  planExactSchema,
  z.union([planOutputSchema, missingContextOutputSchema]),
  mandated,
)
const planReviewStart = z
  .strictObject({
    format: z.literal(ACTION_RECEIPT_FORMAT),
    phase: z.literal('start'),
    action: z.literal('plan-review'),
    actionId: identifierSchema,
    mandate: mandated,
    inputs: actionInputsSchema,
    exactInputs: planReviewExactSchema,
    slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  })
  .superRefine((value, context) => declaredPlanSlots(value.slots, context))
const planReviewResult = z.strictObject({
  format: z.literal(ACTION_RECEIPT_FORMAT),
  phase: z.literal('result'),
  action: z.literal('plan-review'),
  actionId: identifierSchema,
  mandate: mandated,
  inputs: actionInputsSchema,
  start: externalRecordRefSchema,
  exactInputs: planReviewExactSchema,
  slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  contributions: z.array(nestedPlanContributionSchema),
  native: nativeOutcomeSchema,
  structured: missingContextOutputSchema.nullable(),
  admission: hostEffectAdmissionSchema.nullable(),
  diagnostics: z.array(diagnosticSchema),
})
const [implementStart, implementResult] = actionReceipt(
  'implement',
  implementExactSchema,
  z.union([
    implementationOutputSchema,
    producerImplementationOutputSchema.refine((value) => value.outcome === 'blocked' && value.missing !== undefined),
  ]),
  mandated,
)
const [ciStart, ciResult] = actionReceipt(
  'attribute-ci',
  ciExactSchema,
  z.union([ciAttributionSchema, missingContextOutputSchema]),
  mandated,
)
const [normalizeStart, normalizeResult] = actionReceipt(
  'normalize',
  normalizeExactSchema,
  z.union([normalizationJudgementSchema, missingContextOutputSchema]),
  preMandateRefSchema,
)
export type AssessSpecResultPayload = z.infer<typeof assessResult>
export type ActionReceiptPayload =
  | z.infer<typeof frameStart>
  | z.infer<typeof frameResult>
  | z.infer<typeof frameUnmandatedStart>
  | z.infer<typeof frameUnmandatedResult>
  | z.infer<typeof assessStart>
  | z.infer<typeof assessResult>
  | z.infer<typeof planStart>
  | z.infer<typeof planResult>
  | z.infer<typeof planReviewStart>
  | z.infer<typeof planReviewResult>
  | z.infer<typeof implementStart>
  | z.infer<typeof implementResult>
  | z.infer<typeof ciStart>
  | z.infer<typeof ciResult>
  | z.infer<typeof normalizeStart>
  | z.infer<typeof normalizeResult>
export const actionReceiptPayloadSchema = z
  .union([
    frameStart,
    frameResult,
    frameUnmandatedStart,
    frameUnmandatedResult,
    assessStart,
    assessResult,
    planStart,
    planResult,
    planReviewStart,
    planReviewResult,
    implementStart,
    implementResult,
    ciStart,
    ciResult,
    normalizeStart,
    normalizeResult,
  ])
  .superRefine(refineActionReceipt) as z.ZodType<ActionReceiptPayload>
