import { z } from 'zod'
import { actionInputsSchema, pinnedFileRefSchema, pluginPinSchema } from './action-input-schema.ts'
import { partPinSchema, recordPinSchema, reservedRecordIdentitySchema } from './fix-recovery-identities.ts'
import {
  decidedPhaseSchema,
  publicationPrefixPhaseSchema,
  requestBeforeDecisionPhaseSchema,
  reservedOwnedIdentitySchema,
} from './fix-recovery-phase-schema.ts'
import {
  destinationSchema,
  latchNamespaceSchema,
  localEffectsObservationSchema,
  pluginConfigurationSchema,
  processLifetimeSchema,
  rootLifetimeSchema,
} from './fix-recovery-schema.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { specEffectiveSchema } from './spec-effective-schema.ts'
import { operatorConfirmationEvidenceSchema } from './uw-identity-schema.ts'

export const FIX_RECOVERY_FORMAT = 'omp-build-fix-recovery/1' as const
const ref = <K extends string>(kind: K) => externalRecordRefSchema.extend({ kind: z.literal(kind) })
const openedRefSchema = ref('fix-owner')
const settledRefSchema = ref('fix-owner')
const recoveryRefSchema = ref('fix-recovery')
const mandateRefSchema = ref('mandate')
const bindingRefSchema = ref('workflow-binding')

const scopeCutMemberSchema = z.discriminatedUnion('disposition', [
  z.strictObject({
    disposition: z.literal('keep-complete'),
    record: z.strictObject({
      identity: reservedOwnedIdentitySchema,
      envelopeDigest: sha256Schema,
      parts: z.array(partPinSchema).min(1),
    }),
  }),
  z.strictObject({
    disposition: z.literal('retire-incomplete'),
    identity: reservedOwnedIdentitySchema,
    observedParts: z.array(partPinSchema),
  }),
])

export const scopeCutSchema = z.strictObject({
  scope: scopeSchema,
  retiringOpened: openedRefSchema,
  members: z.array(scopeCutMemberSchema),
})
export type ScopeCut = z.infer<typeof scopeCutSchema>

export const recoveryHistoryCutSchema = z.strictObject({
  scope: scopeSchema,
  expectedAuthor: z.string().min(1),
  stopAuthor: z.string().min(1).nullable(),
  complete: z.literal(true),
  parts: z.array(partPinSchema),
})
export const recoveryGraphFactsSchema = z.strictObject({
  root: scopeSchema,
  nodes: z.array(
    z.strictObject({
      uw: scopeSchema,
      title: z.string(),
      raw: z.strictObject({ reference: z.string().min(1), body: z.string(), bodySha256: sha256Schema }),
      labels: z.array(z.string()),
      wayfinderLabels: z.array(z.string()),
      parent: scopeSchema.nullable(),
      children: z.array(scopeSchema),
      blockers: z.array(scopeSchema),
      native: z.strictObject({ state: z.enum(['OPEN', 'CLOSED']), stateReason: z.string().nullable() }),
    }),
  ),
})
const priorRecoveryOwnerFactSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('exact-lifetime-ended'),
    ended: z.discriminatedUnion('basis', [
      z.strictObject({ basis: z.literal('absent-in-validated-procfs') }),
      z.strictObject({ basis: z.literal('pid-reused'), observed: processLifetimeSchema }),
    ]),
  }),
  z.strictObject({ kind: z.literal('sealed-drained-live') }),
])
const fixRecoveryObservationSchema = z.strictObject({
  format: z.literal('omp-build-fix-recovery-observation/1'),
  histories: z.array(recoveryHistoryCutSchema).min(1),
  graph: recoveryGraphFactsSchema,
  authority: z.strictObject({
    binding: recordPinSchema('workflow-binding'),
    mandate: recordPinSchema('mandate'),
    plugin: pluginPinSchema,
    configuration: pluginConfigurationSchema,
    accepted: specEffectiveSchema,
  }),
  catalogues: z.array(z.strictObject({ ref: pinnedFileRefSchema, contents: z.string() })).optional(),
  pullRequest: z.strictObject({
    scope: scopeSchema,
    state: z.literal('open'),
    candidateGitSHA: gitObjectIdSchema,
    baseGitSHA: gitObjectIdSchema,
    headRepository: z.string().min(1),
    branch: z.string().min(1),
    base: z.string().min(1),
    destination: destinationSchema,
  }),
  local: localEffectsObservationSchema.extend({
    status: z.strictObject({ format: z.literal('git-status-porcelain-v1'), stdout: z.string() }),
  }),
  host: z.strictObject({
    process: processLifetimeSchema,
    root: rootLifetimeSchema,
    namespace: latchNamespaceSchema,
    prior: priorRecoveryOwnerFactSchema,
  }),
})
export type FixRecoveryObservation = z.infer<typeof fixRecoveryObservationSchema>
const fixRecoveryNativePreparationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('prepared'),
    causeId: identifierSchema,
    actionId: identifierSchema,
    inputs: actionInputsSchema,
  }),
  z.strictObject({ kind: z.literal('no-native-action') }),
])

const proposalCommonFields = {
  format: z.literal('omp-build-fix-recovery-proposal/1'),
  operationId: identifierSchema,
  control: reservedRecordIdentitySchema('fix-recovery'),
  uw: scopeSchema,
  pullRequest: scopeSchema,
  binding: bindingRefSchema,
  mandate: mandateRefSchema,
  predecessor: recoveryRefSchema.nullable(),
  opened: openedRefSchema,
  settled: settledRefSchema,
  cuts: z.array(scopeCutSchema).min(1),
  observation: fixRecoveryObservationSchema,
  observationDigest: sha256Schema,
  expected: z.strictObject({
    currentStateDigest: sha256Schema,
    headDigest: sha256Schema,
    pinDigest: sha256Schema,
    mandateDigest: sha256Schema,
    acceptedSpecDigest: sha256Schema,
  }),
}
export const fixRecoveryProposalSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    ...proposalCommonFields,
    phase: z.literal('close-publication'),
    target: publicationPrefixPhaseSchema,
  }),
  z.strictObject({
    ...proposalCommonFields,
    phase: z.literal('close-predecision'),
    target: requestBeforeDecisionPhaseSchema,
  }),
  z.strictObject({
    ...proposalCommonFields,
    phase: z.literal('adopt-decision'),
    target: decidedPhaseSchema,
    claimReservation: reservedRecordIdentitySchema('fix-owner'),
    nativePreparation: fixRecoveryNativePreparationSchema,
  }),
])
export type FixRecoveryProposal = z.infer<typeof fixRecoveryProposalSchema>
export type PreparedFixRecovery = Readonly<{ proposal: FixRecoveryProposal; digest: string }>

const controlCommonFields = {
  format: z.literal(FIX_RECOVERY_FORMAT),
  uw: scopeSchema,
  pullRequest: scopeSchema,
  binding: bindingRefSchema,
  mandate: mandateRefSchema,
  predecessor: recoveryRefSchema.nullable(),
  opened: openedRefSchema,
  settled: settledRefSchema,
  cuts: z.array(scopeCutSchema).min(1),
  observation: fixRecoveryObservationSchema,
  observationDigest: sha256Schema,
  proposalDigest: sha256Schema,
  confirmation: operatorConfirmationEvidenceSchema,
}

export const fixRecoveryPayloadSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    ...controlCommonFields,
    phase: z.literal('close-publication'),
    target: publicationPrefixPhaseSchema,
  }),
  z.strictObject({
    ...controlCommonFields,
    phase: z.literal('close-predecision'),
    target: requestBeforeDecisionPhaseSchema,
  }),
  z.strictObject({
    ...controlCommonFields,
    phase: z.literal('adopt-decision'),
    target: decidedPhaseSchema,
    claimReservation: reservedRecordIdentitySchema('fix-owner'),
    nativePreparation: fixRecoveryNativePreparationSchema,
  }),
])
export type FixRecoveryPayload = z.infer<typeof fixRecoveryPayloadSchema>
export type RecoveryControl = FixRecoveryPayload
