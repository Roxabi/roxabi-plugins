import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import { sha256Schema } from './record-values.ts'
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
export const specIdentityPayloadSchema = z.discriminatedUnion('event', [
  z.strictObject({
    ...common,
    event: z.literal('allocate'),
    allocations: z.array(z.strictObject({ draftKey: z.string().min(1), id: specItemIdSchema })).min(1),
  }),
  z.strictObject({ ...common, event: z.literal('retire-proposed'), ids: z.array(specItemIdSchema).min(1) }),
])
export type SpecIdentityPayload = z.infer<typeof specIdentityPayloadSchema>
