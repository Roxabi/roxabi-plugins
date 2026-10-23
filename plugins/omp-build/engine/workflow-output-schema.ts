import { z } from 'zod'
import { specDigest } from './record-digests.ts'
import {
  identifierSchema,
  implementationCommandSchema,
  jsonSchema,
  repoRelativePathSchema,
  shaSchema,
} from './record-values.ts'

export const specAssessmentSchema = z.strictObject({
  classification: z.enum(['editorial', 'material', 'unknown']),
})
export type SpecAssessment = z.infer<typeof specAssessmentSchema>
export const planStepSchema = z.strictObject({
  id: identifierSchema,
  change: z.string().min(1),
  doneWhen: z.string().min(1),
  criterion: z.string().min(1),
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
  criterion: z.string().min(1),
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
    commitSHAs: z.array(shaSchema).min(1),
    commands: z.array(implementationCommandSchema).min(1),
    proofToolCallId: identifierSchema,
    proofUnavailableReason: z.null(),
    reason: z.string(),
  }),
  z.strictObject({
    outcome: z.literal('blocked'),
    commitSHAs: z.array(shaSchema),
    commands: z.array(implementationCommandSchema),
    proofToolCallId: z.null(),
    proofUnavailableReason: z.string().min(1),
    reason: z.string().min(1),
  }),
])
export type ImplementationOutput = z.infer<typeof implementationOutputSchema>
export const ciAttributionSchema = z.strictObject({
  attribution: z.enum(['change', 'pre-existing', 'infra', 'unknown', 'out-of-scope']),
  evidence: jsonSchema,
})
export type CiAttribution = z.infer<typeof ciAttributionSchema>
