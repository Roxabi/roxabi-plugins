import { z } from 'zod'
import { failedCheckEvidenceDigest, failedCheckFailureSchema } from './record-digests.ts'
import { type ExternalRecordRef, externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import {
  contributionSchema,
  diagnosticSchema,
  identifierSchema,
  nativeOutcomeSchema,
  repoRelativePathSchema,
  scopeSchema,
  sha256Schema,
  shaSchema,
} from './record-values.ts'
import { specItemIdSchema, specSnapshotSchema, uwTierSchema } from './uw-spec-schema.ts'
import { acceptedChildCommitmentSchema, sameRefMeaning } from './workflow-mandate-schema.ts'
import {
  ciAttributionSchema,
  implementationOutputSchema,
  planBlockerRefSchema,
  planOutputSchema,
  specAssessmentSchema,
} from './workflow-output-schema.ts'

export const workflowReceiptActionSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'plan-review',
  'implement',
  'attribute-ci',
])
export type WorkflowReceiptAction = z.infer<typeof workflowReceiptActionSchema>
const ownSpecRefSchema = z.strictObject({
  uw: scopeSchema,
  version: sha256Schema,
  sourceAccepted: externalRecordRefSchema,
})
const assessedOwnStateSchema = z.strictObject({
  snapshot: specSnapshotSchema,
  tier: uwTierSchema,
  children: z.array(acceptedChildCommitmentSchema),
})
const mechanicalSpecDeltaSchema = z.strictObject({
  added: z.array(specItemIdSchema),
  removed: z.array(specItemIdSchema),
  changedStatements: z.array(specItemIdSchema),
  exclusionsChanged: z.boolean(),
  tierChanged: z.boolean(),
  childrenChanged: z.boolean(),
  sectionsOrOrderChanged: z.boolean(),
})
export const assessSpecExactSchema = z.strictObject({
  format: z.literal('omp-build-spec-assessment/2'),
  accepted: assessedOwnStateSchema.extend({ ref: ownSpecRefSchema }),
  proposed: assessedOwnStateSchema,
  identityAllocations: z.array(externalRecordRefSchema),
  mechanical: mechanicalSpecDeltaSchema,
})
export type AssessSpecExact = z.infer<typeof assessSpecExactSchema>
const frameExactSchema = z.strictObject({
  specDigest: sha256Schema,
  branch: z.string().min(1),
  base: z.string().min(1),
})
export const PLAN_REVIEW_SPECIALISTS = ['R-workflow-plan-architect', 'R-workflow-plan-adversarial'] as const
export const planReviewSpecialistSchema = z.enum(PLAN_REVIEW_SPECIALISTS)
export const planReviewSlotSchema = z.strictObject({
  slotId: identifierSchema,
  specialist: planReviewSpecialistSchema,
})
export type PlanReviewSlot = z.infer<typeof planReviewSlotSchema>

const planExactSchema = z
  .strictObject({
    mandateId: identifierSchema,
    specDigest: sha256Schema,
    amendsReviewActionId: identifierSchema.nullable(),
    requiredBlockers: z.array(planBlockerRefSchema),
  })
  .superRefine((value, context) => {
    if (value.amendsReviewActionId === null && value.requiredBlockers.length !== 0) {
      context.addIssue({
        code: 'custom',
        path: ['requiredBlockers'],
        message: 'a draft does not require review blockers',
      })
    }
    const seen = new Set<string>()
    for (const [index, ref] of value.requiredBlockers.entries()) {
      const key = `${ref.sourceId}\0${ref.slotId}\0${ref.blockerId}`
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['requiredBlockers', index],
          message: 'blocker reference is repeated',
        })
      }
      seen.add(key)
    }
  })
const planReviewExactSchema = z.strictObject({
  mandateId: identifierSchema,
  specDigest: sha256Schema,
  planDigest: sha256Schema,
  draftActionId: identifierSchema,
})
const implementExactSchema = z.strictObject({ mandateId: identifierSchema, planActionId: identifierSchema })
const ciExactSchema = z
  .strictObject({
    candidateGitSHA: shaSchema,
    scope: scopeSchema,
    failedChecks: z.array(z.string().min(1)),
    evidenceDigest: sha256Schema,
    failures: z.array(failedCheckFailureSchema).min(1),
  })
  .superRefine((value, context) => {
    const digest = failedCheckEvidenceDigest(value)
    if (digest === null || digest !== value.evidenceDigest) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceDigest'],
        message: 'evidence digest does not match the native check identity',
      })
    }
  })
export const implementationAdmissionCommandSchema = z.strictObject({
  toolCallId: identifierSchema,
  command: z.string(),
  exitCode: z.number().int(),
  cwd: z.string().min(1),
})
export type ImplementationAdmissionCommand = z.infer<typeof implementationAdmissionCommandSchema>
export const hostEffectAdmissionSchema = z.strictObject({
  admitted: z.boolean(),
  commits: z.array(gitObjectIdSchema),
  paths: z.array(repoRelativePathSchema),
  commands: z.array(implementationAdmissionCommandSchema),
  remoteBranch: z.string().min(1).nullable(),
  remoteTip: gitObjectIdSchema.nullable(),
  published: z.boolean(),
  reason: z.string(),
})
export type HostEffectAdmission = z.infer<typeof hostEffectAdmissionSchema>
const nestedPlanContributionSchema = contributionSchema.superRefine((value, context) => {
  if (value.inventoryId !== null) {
    context.addIssue({
      code: 'custom',
      path: ['inventoryId'],
      message: 'plan-review contribution inventoryId must be null',
    })
  }
  if (value.host.slotId === null) {
    context.addIssue({
      code: 'custom',
      path: ['host', 'slotId'],
      message: 'plan-review contribution names its declared slot',
    })
  }
})

function actionReceipt<A extends WorkflowReceiptAction, E extends z.ZodType, S extends z.ZodType>(
  action: A,
  exact: E,
  structured: S,
) {
  return [
    z.strictObject({
      phase: z.literal('start'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      exactInputs: exact,
    }),
    z.strictObject({
      phase: z.literal('result'),
      action: z.literal(action),
      actionId: identifierSchema,
      mandate: externalRecordRefSchema,
      start: externalRecordRefSchema,
      exactInputs: exact,
      native: nativeOutcomeSchema,
      structured: structured.nullable(),
      admission: hostEffectAdmissionSchema.nullable(),
      diagnostics: z.array(diagnosticSchema),
    }),
  ] as const
}

const declaredPlanSlots = (slots: readonly PlanReviewSlot[], context: z.RefinementCtx): void => {
  const ids = new Set<string>()
  const specialists = new Set<string>()
  for (const [index, slot] of slots.entries()) {
    if (ids.has(slot.slotId)) {
      context.addIssue({ code: 'custom', path: ['slots', index, 'slotId'], message: `slot ${slot.slotId} is repeated` })
    }
    ids.add(slot.slotId)
    if (specialists.has(slot.specialist)) {
      context.addIssue({
        code: 'custom',
        path: ['slots', index, 'specialist'],
        message: `specialist ${slot.specialist} is repeated`,
      })
    }
    specialists.add(slot.specialist)
  }
  for (const name of PLAN_REVIEW_SPECIALISTS) {
    if (!specialists.has(name)) {
      context.addIssue({ code: 'custom', path: ['slots'], message: `missing specialist ${name}` })
    }
  }
}
const [frameStart, frameResult] = actionReceipt('frame', frameExactSchema, z.null())
const [assessStart, assessResult] = actionReceipt('assess-spec', assessSpecExactSchema, specAssessmentSchema)
const [planStart, planResult] = actionReceipt('plan', planExactSchema, planOutputSchema)
const planReviewStart = z
  .strictObject({
    phase: z.literal('start'),
    action: z.literal('plan-review'),
    actionId: identifierSchema,
    mandate: externalRecordRefSchema,
    exactInputs: planReviewExactSchema,
    slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  })
  .superRefine((value, context) => declaredPlanSlots(value.slots, context))
const planReviewResult = z.strictObject({
  phase: z.literal('result'),
  action: z.literal('plan-review'),
  actionId: identifierSchema,
  mandate: externalRecordRefSchema,
  start: externalRecordRefSchema,
  exactInputs: planReviewExactSchema,
  slots: z.array(planReviewSlotSchema).length(PLAN_REVIEW_SPECIALISTS.length),
  contributions: z.array(nestedPlanContributionSchema),
  native: nativeOutcomeSchema,
  structured: z.null(),
  admission: hostEffectAdmissionSchema.nullable(),
  diagnostics: z.array(diagnosticSchema),
})
const [implementStart, implementResult] = actionReceipt('implement', implementExactSchema, implementationOutputSchema)
const [ciStart, ciResult] = actionReceipt('attribute-ci', ciExactSchema, ciAttributionSchema)
// z.infer of the combined union drops action/phase pairing. The explicit union is the type.
export type AssessSpecResultPayload = z.infer<typeof assessResult>
export type ActionReceiptPayload =
  | z.infer<typeof frameStart>
  | z.infer<typeof frameResult>
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
export const actionReceiptPayloadSchema = z
  .union([
    frameStart,
    frameResult,
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
  ])
  .superRefine((receipt, context) => {
    const refs: ExternalRecordRef[] = [receipt.mandate]
    if (receipt.phase === 'result') refs.push(receipt.start)
    if (receipt.action === 'assess-spec') {
      refs.push(receipt.exactInputs.accepted.ref.sourceAccepted, ...receipt.exactInputs.identityAllocations)
    }
    sameRefMeaning(refs, context)
    if (receipt.action !== 'plan-review') return
    declaredPlanSlots(receipt.slots, context)
    if (receipt.phase !== 'result') return
    const ids = new Set(receipt.slots.map((slot) => slot.slotId))
    for (const [index, contribution] of receipt.contributions.entries()) {
      if (contribution.host.slotId === null || !ids.has(contribution.host.slotId)) {
        context.addIssue({
          code: 'custom',
          path: ['contributions', index, 'host', 'slotId'],
          message: 'contribution slot is not declared',
        })
      }
    }
  }) as z.ZodType<ActionReceiptPayload>
