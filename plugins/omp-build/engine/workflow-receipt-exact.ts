import { z } from 'zod'
import { contextNegativeBindingSchema } from './action-context.ts'
import { validateActionInputs } from './action-input.ts'
import { failedCheckEvidenceDigest, failedCheckFailureSchema } from './record-digests.ts'
import { type ExternalRecordRef, externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import {
  contributionSchema,
  identifierSchema,
  repoRelativePathSchema,
  scopeSchema,
  sha256Schema,
  shaSchema,
} from './record-values.ts'
import { ownSpecRefSchema, specItemIdSchema, specSnapshotSchema, uwTierSchema } from './uw-spec-schema.ts'
import { acceptedChildCommitmentSchema, sameRefMeaning } from './workflow-mandate-schema.ts'
import { planBlockerRefSchema } from './workflow-output-schema.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

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
export const frameExactSchema = z.strictObject({
  specDigest: sha256Schema,
  branch: z.string().min(1),
  base: z.string().min(1),
})
export const preMandateFrameExactSchema = z.strictObject({
  branch: z.string().min(1),
  base: z.string().min(1),
})
export const normalizeExactSchema = z.strictObject({
  uw: scopeSchema,
  bodySha256: sha256Schema,
})
export const PLAN_REVIEW_SPECIALISTS = ['R-workflow-plan-architect', 'R-workflow-plan-adversarial'] as const
export const planReviewSpecialistSchema = z.enum(PLAN_REVIEW_SPECIALISTS)
export const planReviewSlotSchema = z.strictObject({
  slotId: identifierSchema,
  specialist: planReviewSpecialistSchema,
  action: contextNegativeBindingSchema.optional(),
})
export type PlanReviewSlot = z.infer<typeof planReviewSlotSchema>
export const planExactSchema = z
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
export const planReviewExactSchema = z.strictObject({
  mandateId: identifierSchema,
  specDigest: sha256Schema,
  planDigest: sha256Schema,
  draftActionId: identifierSchema,
})
export const implementExactSchema = z.strictObject({ mandateId: identifierSchema, planActionId: identifierSchema })
export const ciExactSchema = z
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
export const nestedPlanContributionSchema = contributionSchema.superRefine((value, context) => {
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

export function declaredPlanSlots(slots: readonly PlanReviewSlot[], context: z.RefinementCtx): void {
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

function issue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

function normalizeSourceDigest(spec: ActionReceiptPayload['inputs']['manifest']['spec']): string | null {
  if (spec.kind === 'unframed') return spec.source.bodySha256
  if (spec.kind === 'proposed') return spec.snapshot.raw.bodySha256
  return null
}

function refineAbsentMandate(receipt: AbsentReceipt, context: z.RefinementCtx): void {
  if (receipt.action !== 'frame' && receipt.action !== 'normalize') {
    issue(context, ['mandate'], 'absent mandate authorizes nothing')
  }
  const spec = receipt.inputs.manifest.spec
  if (spec.kind !== 'unframed' && spec.kind !== 'proposed') {
    issue(context, ['inputs', 'manifest', 'spec'], 'pre-mandate receipt cannot carry an accepted or absent Spec')
  }
  if (receipt.action !== 'normalize' || !('bodySha256' in receipt.exactInputs)) return
  if (normalizeSourceDigest(spec) !== receipt.exactInputs.bodySha256) {
    issue(context, ['exactInputs', 'bodySha256'], 'normalize digest does not match the raw source')
  }
}

function mandatedRefs(receipt: Exclude<ActionReceiptPayload, { mandate: { kind: 'absent' } }>): ExternalRecordRef[] {
  const refs: ExternalRecordRef[] = [receipt.mandate]
  if (receipt.phase === 'result') refs.push(receipt.start)
  if (receipt.action === 'assess-spec') {
    refs.push(receipt.exactInputs.accepted.ref.sourceAccepted, ...receipt.exactInputs.identityAllocations)
  }
  return refs
}

function refuseUndeclaredSlots(
  receipt: Extract<ActionReceiptPayload, { action: 'plan-review'; phase: 'result' }>,
  context: z.RefinementCtx,
): void {
  const ids = new Set(receipt.slots.map((slot) => slot.slotId))
  for (const [index, contribution] of receipt.contributions.entries()) {
    if (contribution.host.slotId === null || !ids.has(contribution.host.slotId)) {
      issue(context, ['contributions', index, 'host', 'slotId'], 'contribution slot is not declared')
    }
  }
}

type AbsentReceipt = Extract<ActionReceiptPayload, { mandate: { kind: 'absent' } }>
type MandatedReceipt = Exclude<ActionReceiptPayload, { mandate: { kind: 'absent' } }>

function absentMandate(receipt: ActionReceiptPayload): receipt is AbsentReceipt {
  return receipt.mandate.kind === 'absent'
}

function refineMandatedReceipt(receipt: MandatedReceipt, context: z.RefinementCtx): void {
  sameRefMeaning(mandatedRefs(receipt), context)
  if (receipt.action !== 'plan-review') return
  declaredPlanSlots(receipt.slots, context)
  if (receipt.phase !== 'result') return
  refuseUndeclaredSlots(receipt, context)
}

export function refineActionReceipt(receipt: ActionReceiptPayload, context: z.RefinementCtx): void {
  const checked = validateActionInputs(receipt.inputs)
  if (!checked.ok) issue(context, ['inputs'], checked.diagnostics[0]?.message ?? 'action inputs are not binding/1')
  if (absentMandate(receipt)) {
    refineAbsentMandate(receipt, context)
    return
  }
  refineMandatedReceipt(receipt, context)
}
