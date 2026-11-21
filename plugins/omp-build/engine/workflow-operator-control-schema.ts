import { z } from 'zod'
import { causeDependencyAdjustmentProposalSchema } from './cause-dependency-adjustment-schema.ts'
import { type ExternalRecordRef, externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, jsonSchema, sha256Schema } from './schema-primitives.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'
import { nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import { specItemIdSchema } from './uw-spec-schema.ts'
import { materialAuthorizationSchema, sameRefMeaning } from './workflow-mandate-schema.ts'

const disarmSchema = z.strictObject({ observed: z.literal(true), evidence: jsonSchema })
const identityDeltaSchema = z.strictObject({ retired: z.array(specItemIdSchema) }).superRefine((value, context) => {
  if (new Set(value.retired).size !== value.retired.length)
    context.addIssue({ code: 'custom', path: ['retired'], message: 'retired identities are repeated' })
})
const controlShared = { controlId: identifierSchema, mandate: externalRecordRefSchema }
/** Durable proof that this exact START did not dispatch a native child. */
export const interruptionExecutorSchema = z.strictObject({ kind: z.literal('not-dispatched') })
export const interruptionRuntimeSchema = z.strictObject({
  productVersion: z.string().min(1),
  configVersion: z.string().min(1),
  configDigest: sha256Schema,
})
export const interruptionActionSchema = z.enum([
  'plan',
  'plan-review',
  'implement',
  'integrate',
  'assess-spec',
  'attribute-ci',
])
export const operatorControlPayloadSchema = z
  .discriminatedUnion('control', [
    z.strictObject({ control: z.literal('pause-requested'), predecessor: z.null(), ...controlShared }),
    z.strictObject({
      control: z.literal('pause-confirmed'),
      predecessor: externalRecordRefSchema,
      disarm: disarmSchema,
      ...controlShared,
    }),
    z.strictObject({ control: z.literal('resume'), predecessor: externalRecordRefSchema, ...controlShared }),
    z.strictObject({
      control: z.literal('abandon'),
      predecessor: externalRecordRefSchema.nullable(),
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('adjust-cause-dependency'),
      proposal: causeDependencyAdjustmentProposalSchema,
      proposalDigest: sha256Schema,
      confirmation: operatorConfirmationEvidenceSchema,
      execution: z.strictObject({ observed: nativeIssueObservationSchema }),
    }),
    z.strictObject({
      control: z.literal('accept-material'),
      predecessor: externalRecordRefSchema,
      assessment: externalRecordRefSchema,
      specVersion: sha256Schema,
      proposalDigest: sha256Schema,
      authorization: materialAuthorizationSchema,
      confirmation: operatorConfirmationEvidenceSchema,
      identityDelta: identityDeltaSchema,
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('select-successor'),
      predecessor: externalRecordRefSchema,
      successor: externalRecordRefSchema,
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('resolve-interruption'),
      predecessor: externalRecordRefSchema,
      action: interruptionActionSchema,
      actionId: identifierSchema,
      start: externalRecordRefSchema,
      result: externalRecordRefSchema.nullable(),
      executor: interruptionExecutorSchema,
      runtime: interruptionRuntimeSchema,
      proposalDigest: sha256Schema,
      confirmation: operatorConfirmationEvidenceSchema,
      ...controlShared,
    }),
  ])
  .superRefine((control, context) => {
    const refs: Array<ExternalRecordRef | null> =
      control.control === 'adjust-cause-dependency'
        ? [
            control.proposal.mandate,
            control.proposal.predecessor,
            control.proposal.disposition,
            control.proposal.receipt,
            control.proposal.accepted.sourceAccepted,
            ...control.proposal.versionVector.map((ref) => ref.sourceAccepted),
          ]
        : [control.mandate, control.predecessor]
    if (control.control === 'accept-material') {
      refs.push(control.assessment)
      if (control.authorization.kind === 'cause-creation')
        refs.push(control.authorization.operation, control.authorization.binding.identity)
    }
    if (control.control === 'select-successor') refs.push(control.successor)
    if (control.control === 'resolve-interruption') refs.push(control.start, control.result)
    sameRefMeaning(refs, context)
  })
export type OperatorControlPayload = z.infer<typeof operatorControlPayloadSchema>
