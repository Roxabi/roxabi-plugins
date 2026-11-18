import { z } from 'zod'
import { recordInputRefSchema } from './action-input-refs.ts'
import { codeRangeSchema } from './code-range-schema.ts'
import { contextEffectNegativeRefSchema, contextEffectReviewSchema } from './context-effect-review-schema.ts'
import { codeVersionSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { jsonSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'
import { ownSpecRefSchema } from './uw-spec-schema.ts'

const deliverySchema = z.strictObject({
  uw: scopeSchema,
  pullRequests: z.array(
    z.strictObject({
      pullRequest: scopeSchema,
      branch: z.string().min(1),
      base: z.string().min(1),
      head: gitObjectIdSchema,
      baseTip: gitObjectIdSchema,
      state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
      mergeCommit: gitObjectIdSchema.nullable(),
    }),
  ),
  integrations: z.array(z.strictObject({ source: recordInputRefSchema, code: codeRangeSchema })),
  commits: z.array(z.strictObject({ code: codeVersionSchema, parents: z.array(gitObjectIdSchema) })),
})
const managedBaseline = z.strictObject({
  kind: z.literal('unchanged-delivery-baseline'),
  scope: z.literal('workflow-owned-delivery-state'),
  code: codeRangeSchema,
  repository: z.string().min(1),
  branch: z.string().min(1).nullable(),
  status: z.strictObject({ code: z.literal(0), stdout: z.literal('') }),
  remote: z.strictObject({
    base: z.strictObject({ ref: z.string().min(1), tip: gitObjectIdSchema }),
    candidate: z.strictObject({ ref: z.string().min(1), tip: gitObjectIdSchema.nullable() }).nullable(),
  }),
  delivery: deliverySchema,
  cuts: z
    .array(
      z.strictObject({
        scope: scopeSchema,
        count: z.number().int().nonnegative(),
        last: z
          .strictObject({
            operationId: z.string().nullable(),
            recordId: z.string().nullable(),
            kind: z.string().nullable(),
          })
          .nullable(),
      }),
    )
    .superRefine((cuts, context) => {
      cuts.forEach((cut, index) => {
        if ((cut.count === 0) !== (cut.last === null))
          context.addIssue({
            code: 'custom',
            path: [index, 'last'],
            message: 'empty cut must have no last operation',
          })
      })
    }),
  historyDigest: sha256Schema,
  bindingDigest: sha256Schema,
})
const candidateConsistent = (value: z.infer<typeof managedBaseline>) =>
  (value.branch === null) === (value.remote.candidate === null)
const candidateIssue = {
  path: ['remote', 'candidate'],
  message: 'candidate and branch must both be present or both absent',
}

/** A fresh managed-state sample never re-observes historical named-file effects. */
export const contextSuccessionManagedBaselineSchema = managedBaseline.refine(candidateConsistent, candidateIssue)
export type ContextSuccessionManagedBaseline = z.infer<typeof contextSuccessionManagedBaselineSchema>
export const contextSuccessionReconciliationSchema = managedBaseline
  .extend({ effectReview: contextEffectReviewSchema })
  .refine(candidateConsistent, candidateIssue)

export const contextDispositionSchema = z.strictObject({
  kind: z.literal('superseded-not-delivered'),
  negative: contextEffectNegativeRefSchema,
  replacementAccepted: ownSpecRefSchema,
  reconciliation: contextSuccessionReconciliationSchema,
  proposalDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
})
export const contextSuccessionProposalSchema = z.strictObject({
  format: z.literal('omp-build-context-succession/1'),
  uw: scopeSchema,
  operationId: z.string().min(1),
  controlId: z.string().min(1),
  predecessor: externalRecordRefSchema.extend({ kind: z.literal('mandate') }),
  successor: externalRecordRefSchema.extend({ kind: z.literal('mandate') }),
  successorPayloadDigest: sha256Schema,
  predecessorConfig: z.strictObject({
    productVersion: z.string().min(1),
    version: z.string().min(1),
    digest: sha256Schema,
    effective: jsonSchema,
  }),
  successorConfig: z.strictObject({
    productVersion: z.string().min(1),
    version: z.string().min(1),
    digest: sha256Schema,
    effective: jsonSchema,
  }),
  negative: contextDispositionSchema.shape.negative,
  replacementAccepted: ownSpecRefSchema,
  reconciliation: contextSuccessionReconciliationSchema,
})
export type ContextSuccessionProposal = z.infer<typeof contextSuccessionProposalSchema>
export type ContextDisposition = z.infer<typeof contextDispositionSchema>
