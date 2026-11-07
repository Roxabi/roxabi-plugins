import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import { sha256Schema } from './schema-primitives.ts'
import { specItemIdSchema } from './uw-spec-schema.ts'
export const SPEC_IDENTITY_FORMAT = 'omp-build-spec-identity/1' as const
export const operatorConfirmationEvidenceSchema = z.strictObject({
  route: z.literal('omp-native-command'),
  operationId: z.string().min(1),
  proposalDigest: sha256Schema,
  confirmedAt: z.string().datetime(),
})
export type OperatorConfirmationEvidence = z.infer<typeof operatorConfirmationEvidenceSchema>
const common = {
  format: z.literal(SPEC_IDENTITY_FORMAT),
  predecessor: externalRecordRefSchema.nullable(),
  proposalDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
}
export const framingMemberAuthorizationSchema = z.strictObject({
  kind: z.literal('framing-member'),
  intent: externalRecordRefSchema.extend({ kind: z.literal('framing-receipt') }),
  claim: externalRecordRefSchema.extend({ kind: z.literal('framing-receipt') }),
  binding: externalRecordRefSchema.extend({ kind: z.literal('framing-receipt') }),
  member: z.string().min(1),
  memberDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
})
export type FramingMemberAuthorization = z.infer<typeof framingMemberAuthorizationSchema>
const allocationsSchema = z.array(z.strictObject({ draftKey: z.string().min(1), id: specItemIdSchema })).min(1)
const singletonIdentityPayloadSchema = z.discriminatedUnion('event', [
  z.strictObject({ ...common, event: z.literal('allocate'), allocations: allocationsSchema }),
  z.strictObject({ ...common, event: z.literal('retire-proposed'), ids: z.array(specItemIdSchema).min(1) }),
])
const aggregateCommon = {
  format: z.literal('omp-build-spec-identity/2'),
  predecessor: externalRecordRefSchema.nullable(),
  proposalDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
  aggregate: framingMemberAuthorizationSchema,
}
const aggregateIdentityPayloadSchema = z.discriminatedUnion('event', [
  z.strictObject({ ...aggregateCommon, event: z.literal('allocate'), allocations: allocationsSchema }),
  z.strictObject({ ...aggregateCommon, event: z.literal('retire-proposed'), ids: z.array(specItemIdSchema).min(1) }),
])
export const specIdentityPayloadSchema = z.union([singletonIdentityPayloadSchema, aggregateIdentityPayloadSchema])
export type SpecIdentityPayload = z.infer<typeof specIdentityPayloadSchema>
