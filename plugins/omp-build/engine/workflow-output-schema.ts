import { z } from 'zod'
import { missingContextItemSchema, missingContextOutputSchema } from './action-context.ts'
import { recordInputRefSchema } from './action-input-refs.ts'
import {
  criterionDeclarationSchema,
  observationRefSchema,
  producerCriterionDeclarationSchema,
} from './criterion-evidence-schema.ts'
import { criterionTargetSchema, FINDING_TARGET_FORMAT } from './finding-target-schema.ts'
import { specDigest } from './record-digests.ts'
import { gitObjectIdSchema } from './record-references.ts'
import { identifierSchema, implementationCommandSchema, jsonSchema, repoRelativePathSchema } from './record-values.ts'
import { scopeSchema, sha256Schema } from './schema-primitives.ts'
import { criterionIdSchema, exclusionRefSchema, invariantIdSchema, ownSpecRefSchema } from './uw-spec-schema.ts'

const constraintRefSchema = z.union([
  z.strictObject({
    kind: z.literal('accepted'),
    target: z.union([
      criterionTargetSchema,
      z.strictObject({
        format: z.literal(FINDING_TARGET_FORMAT),
        kind: z.literal('invariant'),
        spec: ownSpecRefSchema,
        id: invariantIdSchema,
      }),
    ]),
  }),
  z.strictObject({ kind: z.literal('accepted-exclusion'), ref: exclusionRefSchema }),
  z.strictObject({
    kind: z.literal('engaged'),
    parent: ownSpecRefSchema,
    engagement: recordInputRefSchema,
    child: scopeSchema,
    version: sha256Schema,
    element: z.union([
      z.strictObject({ kind: z.literal('criterion'), id: criterionIdSchema }),
      z.strictObject({ kind: z.literal('invariant'), id: invariantIdSchema }),
      z.strictObject({ kind: z.literal('exclusion'), index: z.number().int().nonnegative() }),
    ]),
  }),
  z.strictObject({
    kind: z.literal('proposed'),
    subject: z.union([
      z.strictObject({ kind: z.literal('existing'), uw: scopeSchema }),
      z.strictObject({ kind: z.literal('created-by'), operationId: z.string().min(1) }),
    ]),
    version: sha256Schema,
    element: z.union([
      z.strictObject({ kind: z.literal('criterion'), id: criterionIdSchema }),
      z.strictObject({ kind: z.literal('invariant'), id: invariantIdSchema }),
      z.strictObject({ kind: z.literal('exclusion'), index: z.number().int().nonnegative() }),
    ]),
  }),
])
const nonemptyConstraints = z.tuple([constraintRefSchema]).rest(constraintRefSchema)
const nonemptyReferences = z.tuple([observationRefSchema]).rest(observationRefSchema)
const compatibilitySchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('consistent'),
    examined: nonemptyConstraints,
    references: z.array(observationRefSchema),
    reason: z.string().min(1),
  }),
  z.strictObject({
    state: z.literal('conflicting'),
    examined: nonemptyConstraints,
    conflicts: z
      .tuple([
        z.strictObject({
          left: constraintRefSchema,
          right: constraintRefSchema,
          reason: z.string().min(1),
          references: nonemptyReferences,
        }),
      ])
      .rest(
        z.strictObject({
          left: constraintRefSchema,
          right: constraintRefSchema,
          reason: z.string().min(1),
          references: nonemptyReferences,
        }),
      ),
  }),
  z.strictObject({
    state: z.literal('undetermined'),
    examined: nonemptyConstraints,
    constraints: nonemptyConstraints,
    references: z.array(observationRefSchema),
    reason: z.string().min(1),
  }),
])

export const specAssessmentSchema = z.strictObject({
  classification: z.enum(['editorial', 'material', 'unknown']),
  compatibility: compatibilitySchema,
})
export type SpecAssessment = z.infer<typeof specAssessmentSchema>
export const planStepSchema = z.strictObject({
  id: identifierSchema,
  change: z.string().min(1),
  doneWhen: z.string().min(1),
  criterionIds: z.array(criterionIdSchema).min(1),
  evidence: z.string().min(1),
  paths: z.array(repoRelativePathSchema).min(1),
})
export const planBlockerRefSchema = z.strictObject({
  sourceId: identifierSchema,
  slotId: identifierSchema,
  blockerId: identifierSchema,
})
export type PlanBlockerRef = z.infer<typeof planBlockerRefSchema>
export const planResolutionSchema = z.strictObject({
  blocker: planBlockerRefSchema,
  stepIds: z.array(identifierSchema).min(1),
  reason: z.string().min(1),
})
export type PlanResolution = z.infer<typeof planResolutionSchema>
export const planOutputSchema = z
  .strictObject({
    steps: z.array(planStepSchema).min(1),
    resolutions: z.array(planResolutionSchema),
  })
  .superRefine((value, context) => {
    const stepIds = new Set<string>()
    for (const [index, step] of value.steps.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({ code: 'custom', path: ['steps', index, 'id'], message: 'step id is repeated' })
      }
      stepIds.add(step.id)
      const criterionIds = new Set<string>()
      step.criterionIds.forEach((id, criterionIndex) => {
        if (criterionIds.has(id)) {
          context.addIssue({
            code: 'custom',
            path: ['steps', index, 'criterionIds', criterionIndex],
            message: 'criterion id is repeated',
          })
        }
        criterionIds.add(id)
      })
    }
    const seen = new Set<string>()
    for (const [index, resolution] of value.resolutions.entries()) {
      const key = `${resolution.blocker.sourceId}\0${resolution.blocker.slotId}\0${resolution.blocker.blockerId}`
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['resolutions', index, 'blocker'],
          message: 'resolution reference is repeated',
        })
      }
      seen.add(key)
      for (const [stepIndex, stepId] of resolution.stepIds.entries()) {
        if (!stepIds.has(stepId)) {
          context.addIssue({
            code: 'custom',
            path: ['resolutions', index, 'stepIds', stepIndex],
            message: 'resolution names an unknown step',
          })
        }
      }
    }
  })
export type PlanStep = z.infer<typeof planStepSchema>
export type PlanOutput = z.infer<typeof planOutputSchema>
export function planDigest(plan: PlanOutput): string {
  return specDigest(JSON.stringify(plan))
}
const planReviewBlockerSchema = z.strictObject({
  id: identifierSchema,
  criterionId: criterionIdSchema,
  gap: z.string().min(1),
})
export const planReviewSchema = z
  .strictObject({
    outcome: z.enum(['clear', 'blocking']),
    blockers: z.array(planReviewBlockerSchema),
  })
  .superRefine((value, context) => {
    if (value.outcome === 'clear' && value.blockers.length !== 0) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'clear plan review has no blockers' })
    }
    if (value.outcome === 'blocking' && value.blockers.length === 0) {
      context.addIssue({ code: 'custom', path: ['blockers'], message: 'blocking plan review names a blocker' })
    }
    const ids = new Set<string>()
    for (const [index, blocker] of value.blockers.entries()) {
      if (ids.has(blocker.id)) {
        context.addIssue({ code: 'custom', path: ['blockers', index, 'id'], message: 'blocker id is repeated' })
      }
      ids.add(blocker.id)
    }
  })
export type PlanReview = z.infer<typeof planReviewSchema>
export const implementationOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('implemented'),
    commitSHAs: z.array(gitObjectIdSchema).min(1),
    commands: z.array(implementationCommandSchema),
    criteria: z.array(criterionDeclarationSchema),
    reason: z.string(),
  }),
  z.strictObject({
    outcome: z.literal('blocked'),
    commitSHAs: z.array(gitObjectIdSchema),
    commands: z.array(implementationCommandSchema),
    criteria: z.array(criterionDeclarationSchema),
    missing: z.array(missingContextItemSchema).min(1).optional(),
    reason: z.string().min(1),
  }),
])
export const producerImplementationOutputSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('implemented'),
    commitSHAs: z.array(gitObjectIdSchema).min(1),
    commands: z.array(implementationCommandSchema),
    criteria: z.array(producerCriterionDeclarationSchema),
    reason: z.string(),
  }),
  z.strictObject({
    outcome: z.literal('blocked'),
    commitSHAs: z.array(gitObjectIdSchema),
    commands: z.array(implementationCommandSchema),
    criteria: z.array(producerCriterionDeclarationSchema),
    missing: z.array(missingContextItemSchema).min(1).optional(),
    reason: z.string().min(1),
  }),
])
export const deliveryMissingContextSchema = z.union([
  missingContextOutputSchema,
  producerImplementationOutputSchema.refine((value) => value.outcome === 'blocked' && value.missing !== undefined),
])
export type DeliveryMissingContext = z.infer<typeof deliveryMissingContextSchema>
export type ProducerImplementationOutput = z.infer<typeof producerImplementationOutputSchema>
export type ImplementationOutput = z.infer<typeof implementationOutputSchema>
export const ciAttributionSchema = z.strictObject({
  attribution: z.enum(['change', 'pre-existing', 'infra', 'unknown', 'out-of-scope']),
  evidence: jsonSchema,
})
export type CiAttribution = z.infer<typeof ciAttributionSchema>
