import { z } from 'zod'
import { framingInvocationBindingSchema } from './framing-context-schema.ts'
import { issueSpecAnalysisSchema } from './issue-spec-analysis-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { scopeSchema, sha256Schema } from './schema-primitives.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'

export { type FramingMemberAuthorization, framingMemberAuthorizationSchema } from './uw-identity-schema.ts'

import {
  framingAggregateInputSchema,
  framingMaterialCaptureSchema,
  framingMemberKeySchema,
  framingMemberSlotSchema,
} from './uw-framing-schema.ts'
import { nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import { ownSpecRefSchema, specItemIdSchema, specSchema, specSnapshotSchema, uwTierSchema } from './uw-spec-schema.ts'
import { parentCoverageSchema } from './workflow-mandate-schema.ts'

export const framingReceiptRefSchema = externalRecordRefSchema.extend({ kind: z.literal('framing-receipt') })
export type FramingReceiptRef = z.infer<typeof framingReceiptRefSchema>
export const framingMaterialSchema = framingMaterialCaptureSchema.extend({
  conversion: z.enum(['converted', 'not-applicable']),
  parser: z.strictObject({
    status: z.enum(['conformant', 'draft', 'legacy', 'malformed']),
    analysis: issueSpecAnalysisSchema,
    analysisDigest: sha256Schema,
  }),
})
export const framingAllocationSchema = z.strictObject({
  ledgerHead: externalRecordRefSchema.nullable(),
  assignments: z.array(z.strictObject({ draftKey: z.string().min(1), id: specItemIdSchema })),
  retirements: z.array(specItemIdSchema),
  spec: specSchema,
})
export const preparedFramingMemberSchema = z.strictObject({
  key: framingMemberKeySchema,
  ordinal: z.number().int().nonnegative(),
  slot: framingMemberSlotSchema,
  memberDigest: sha256Schema,
  allocation: framingAllocationSchema.nullable(),
  renderedBody: z.string(),
  tier: uwTierSchema.nullable(),
  inherited: z.array(ownSpecRefSchema),
  nativeDigest: sha256Schema.nullable(),
  nativeAnalysis: z
    .strictObject({
      status: z.enum(['conformant', 'draft', 'legacy', 'malformed']),
      analysis: issueSpecAnalysisSchema,
      analysisDigest: sha256Schema,
    })
    .nullable(),
  historyDigest: sha256Schema.nullable(),
  engagementDigest: sha256Schema.nullable(),
})
export const framingProposalSchema = z.strictObject({
  format: z.literal('omp-build-uw-framing/1'),
  operationId: z.string().min(1),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), uw: scopeSchema }),
    z.strictObject({ kind: z.literal('create'), repository: z.string().min(1) }),
  ]),
  input: framingAggregateInputSchema,
  invocation: framingInvocationBindingSchema,
  materials: z.array(framingMaterialSchema),
  members: z.array(preparedFramingMemberSchema).min(1),
})
export type FramingProposal = z.infer<typeof framingProposalSchema>
const resultEdgeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('parent-child'),
    parent: scopeSchema,
    child: scopeSchema,
    origin: z.enum(['observed', 'written']),
  }),
  z.strictObject({
    kind: z.literal('blocker'),
    dependent: scopeSchema,
    blocker: scopeSchema,
    origin: z.enum(['observed', 'written']),
  }),
])
export const boundFramingCoverageIntentSchema = z.strictObject({
  parent: scopeSchema,
  parentVersion: sha256Schema,
  criteria: z.array(z.strictObject({ id: z.string().min(1), statement: z.string() })),
  children: z.array(
    z.strictObject({
      scope: scopeSchema,
      specVersion: sha256Schema,
      tier: uwTierSchema,
      criteria: z.array(z.strictObject({ id: z.string().min(1), statement: z.string() })),
    }),
  ),
  coverage: parentCoverageSchema,
  ancestors: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('accepted'), own: ownSpecRefSchema, metadata: externalRecordRefSchema }),
      z.strictObject({
        kind: z.literal('framing-member'),
        member: framingMemberKeySchema,
        scope: scopeSchema,
        specVersion: sha256Schema,
        tier: uwTierSchema,
        acceptedStateDigest: sha256Schema,
      }),
    ]),
  ),
  aggregateIntent: framingReceiptRefSchema,
  aggregateResult: framingReceiptRefSchema,
})
export type BoundFramingCoverageIntent = z.infer<typeof boundFramingCoverageIntentSchema>
export const framingReceiptPayloadSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    format: z.literal('omp-build-framing-receipt/1'),
    phase: z.literal('intent'),
    root: scopeSchema,
    proposal: framingProposalSchema,
    proposalDigest: sha256Schema,
    confirmation: operatorConfirmationEvidenceSchema,
    native: nativeIssueObservationSchema,
  }),
  z.strictObject({
    format: z.literal('omp-build-framing-receipt/1'),
    phase: z.literal('member-binding'),
    intent: framingReceiptRefSchema,
    member: framingMemberKeySchema,
    memberDigest: sha256Schema,
  }),
  z.strictObject({
    format: z.literal('omp-build-framing-receipt/1'),
    phase: z.literal('member-claim'),
    intent: framingReceiptRefSchema,
    member: framingMemberKeySchema,
    ordinal: z.number().int().nonnegative(),
    memberDigest: sha256Schema,
    scope: scopeSchema,
    slot: z.enum(['existing', 'new']),
    binding: framingReceiptRefSchema.nullable(),
    native: nativeIssueObservationSchema,
  }),
  z.strictObject({
    format: z.literal('omp-build-framing-receipt/1'),
    phase: z.literal('result'),
    intent: framingReceiptRefSchema,
    claims: z.array(framingReceiptRefSchema),
    bindings: z.array(framingReceiptRefSchema),
    identities: z.array(externalRecordRefSchema),
    members: z.array(
      z.strictObject({
        key: framingMemberKeySchema,
        scope: scopeSchema,
        memberDigest: sha256Schema,
        binding: framingReceiptRefSchema,
        snapshot: specSnapshotSchema.nullable(),
        tier: uwTierSchema.nullable(),
      }),
    ),
    edges: z.array(resultEdgeSchema),
    coverage: z.array(boundFramingCoverageIntentSchema.omit({ aggregateResult: true })),
    graphDigest: sha256Schema,
    identityDigest: sha256Schema,
  }),
])
export type FramingReceiptPayload = z.infer<typeof framingReceiptPayloadSchema>
