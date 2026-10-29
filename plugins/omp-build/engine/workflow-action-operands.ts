import { z } from 'zod'
import { failedCheckEvidenceDigest, failedCheckFailureSchema } from './record-digests.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { scopeSchema, sha256Schema, shaSchema } from './schema-primitives.ts'
import { ownSpecRefSchema, specItemIdSchema, specSnapshotSchema, uwTierSchema } from './uw-spec-schema.ts'
import { acceptedChildCommitmentSchema } from './workflow-mandate-schema.ts'

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
export type CiExact = z.infer<typeof ciExactSchema>

export const actionOperandsSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('assess-spec'), exactInputs: assessSpecExactSchema }),
  z.strictObject({ action: z.literal('attribute-ci'), exactInputs: ciExactSchema }),
])
export type ActionOperands = z.infer<typeof actionOperandsSchema>

export function refineActionOperands(
  value: { purpose: string; operands?: ActionOperands },
  context: z.RefinementCtx,
): void {
  if (value.purpose === 'assess-spec' || value.purpose === 'attribute-ci') {
    if (value.operands?.action !== value.purpose) {
      context.addIssue({ code: 'custom', path: ['operands'], message: 'purpose requires matching action operands' })
    }
  } else if (value.operands !== undefined) {
    context.addIssue({ code: 'custom', path: ['operands'], message: 'operands are not allowed for this purpose' })
  }
}
