import { z } from 'zod'
import { type ActionInputManifest, pluginPinSchema } from './action-input-schema.ts'
import { reservedRecordIdentitySchema } from './fix-recovery-identities.ts'
import {
  freshIntakeIntentSchema,
  interruptedPhaseSchema,
  outboundOperationSchema,
  resumeDecisionIntentSchema,
} from './fix-recovery-phase-schema.ts'
import { type ExternalRecordRef, externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { type SpecEffective, specEffectiveSchema } from './spec-effective-schema.ts'

export const FIX_OWNER_FORMAT = 'omp-build-fix-owner/1' as const

const nonnegative = z.number().int().safe().nonnegative()
const positive = z.number().int().safe().positive()
const decimalString = z.string().regex(/^\d+$/)
const absolutePath = z.string().min(1).regex(/^\//)
const destinationRef = z.string().regex(/^refs\/heads\/.+/)

const ref = <K extends string>(kind: K) => externalRecordRefSchema.extend({ kind: z.literal(kind) })
export type OpenedRef = ExternalRecordRef & { kind: 'fix-owner' }
export type SettledRef = ExternalRecordRef & { kind: 'fix-owner' }
export type RecoveryRef = ExternalRecordRef & { kind: 'fix-recovery' }
export type ContributionRef = ExternalRecordRef & { kind: 'contribution' }
export type FixRequestRef = ExternalRecordRef & { kind: 'fix-request' }
export type DecisionRef = ExternalRecordRef & { kind: 'decision' }

const openedRefSchema = ref('fix-owner')
const mandateRefSchema = ref('mandate')
const bindingRefSchema = ref('workflow-binding')
const scopeKey = (scope: z.infer<typeof scopeSchema>) => `${scope.repository}\0${scope.target}`

export const processLifetimeSchema = z.strictObject({
  bootId: identifierSchema,
  userNamespace: identifierSchema,
  pidNamespace: identifierSchema,
  effectiveUid: nonnegative,
  pid: positive,
  processStartTicks: decimalString,
})
export type ProcessLifetime = z.infer<typeof processLifetimeSchema>

export const rootLifetimeSchema = z.strictObject({
  agentId: identifierSchema,
  registryGeneration: nonnegative,
  sessionId: identifierSchema,
  providerSessionId: identifierSchema,
})
export type RootLifetime = z.infer<typeof rootLifetimeSchema>

export const latchNamespaceSchema = z.strictObject({
  protocol: z.literal('omp-build-execution/v1'),
  bootId: identifierSchema,
  effectiveUid: nonnegative,
  userNamespace: identifierSchema,
  pidNamespace: identifierSchema,
  mountNamespace: identifierSchema,
  networkNamespace: identifierSchema,
  canonicalHostRoot: absolutePath,
  rootDevice: decimalString,
  rootInode: decimalString,
  latchRootDevice: decimalString,
  latchRootInode: decimalString,
})
export type LatchNamespace = z.infer<typeof latchNamespaceSchema>

export const destinationSchema = z.strictObject({
  authority: z.string().min(1),
  publicationRepository: z.string().min(1),
  destinationRef,
})
export type Destination = z.infer<typeof destinationSchema>

export const admissionDescriptorSchema = z.strictObject({
  protocol: z.literal('omp-build-destination-mutex/1'),
  destinationDigest: sha256Schema,
  namespace: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('linux-abstract'), networkNamespace: identifierSchema.nullable() }),
    z.strictObject({ kind: z.literal('windows-global') }),
    z.strictObject({ kind: z.literal('darwin-file'), path: absolutePath, device: decimalString, inode: decimalString }),
  ]),
})
export type AdmissionDescriptor = z.infer<typeof admissionDescriptorSchema>
export const fixOwnerHostSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('ordinary-only'),
      platform: z.enum(['linux', 'darwin', 'win32']),
      admission: admissionDescriptorSchema,
    }),
    z.strictObject({
      kind: z.literal('linux-qualified'),
      platform: z.literal('linux'),
      admission: admissionDescriptorSchema,
      process: processLifetimeSchema,
      namespace: latchNamespaceSchema,
    }),
  ])
  .superRefine((host, context) => {
    const expectedKind =
      host.platform === 'linux' ? 'linux-abstract' : host.platform === 'darwin' ? 'darwin-file' : 'windows-global'
    if (host.admission.namespace.kind !== expectedKind)
      context.addIssue({
        code: 'custom',
        path: ['admission'],
        message: 'Admission namespace must match the host platform',
      })
    if (
      host.kind === 'linux-qualified' &&
      (host.namespace.bootId !== host.process.bootId ||
        host.namespace.effectiveUid !== host.process.effectiveUid ||
        host.namespace.userNamespace !== host.process.userNamespace ||
        host.namespace.pidNamespace !== host.process.pidNamespace ||
        host.admission.namespace.kind !== 'linux-abstract' ||
        host.admission.namespace.networkNamespace === null ||
        host.namespace.networkNamespace !== host.admission.namespace.networkNamespace)
    )
      context.addIssue({
        code: 'custom',
        message: 'Qualified namespace must agree with process and observed admission namespace',
      })
  })
export type FixOwnerHost = z.infer<typeof fixOwnerHostSchema>

export const pluginConfigurationSchema = z.strictObject({
  version: z.string().min(1),
  digest: sha256Schema,
  serialized: z.string().min(1),
})

export const ownerCommonSchema = z
  .strictObject({
    owner: reservedRecordIdentitySchema('fix-owner'),
    operationPrefix: identifierSchema,
    host: fixOwnerHostSchema,
    root: rootLifetimeSchema,
    destination: destinationSchema,
    uw: scopeSchema,
    pullRequest: scopeSchema,
    writeScopes: z.array(scopeSchema).min(1),
    mandate: mandateRefSchema,
    binding: bindingRefSchema,
    plugin: pluginPinSchema,
    configuration: pluginConfigurationSchema,
    accepted: specEffectiveSchema,
    acceptedDigest: sha256Schema,
  })
  .superRefine((value, context) => {
    if (scopeKey(value.owner.scope) !== scopeKey(value.uw)) {
      context.addIssue({ code: 'custom', path: ['owner', 'scope'], message: 'Owner scope must be the UW' })
    }
    const keys = value.writeScopes.map(scopeKey)
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', path: ['writeScopes'], message: 'Write scopes must be distinct' })
    }
    const write = new Set(keys)
    if (
      !write.has(scopeKey(value.uw)) ||
      !write.has(scopeKey(value.pullRequest)) ||
      keys.some((key) => key !== scopeKey(value.uw) && key !== scopeKey(value.pullRequest))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['writeScopes'],
        message: 'Write scopes must be exactly the distinct UW and pull request scopes',
      })
    }
    if (scopeKey(value.binding.scope) !== scopeKey(value.pullRequest)) {
      context.addIssue({
        code: 'custom',
        path: ['binding'],
        message: 'Binding scope must match the pull request',
      })
    }
    if (scopeKey(value.mandate.scope) !== scopeKey(value.uw)) {
      context.addIssue({ code: 'custom', path: ['mandate'], message: 'Mandate scope must match the UW' })
    }
  })
export type OwnerCommon = Omit<z.infer<typeof ownerCommonSchema>, 'plugin' | 'configuration' | 'accepted'> & {
  plugin: ActionInputManifest['plugin']
  configuration: ActionInputManifest['configuration']
  accepted: SpecEffective
}

export const localEffectsObservationSchema = z.strictObject({
  head: gitObjectIdSchema,
  remoteHead: gitObjectIdSchema.nullable(),
  statusDigest: sha256Schema,
  clean: z.boolean(),
})
export type LocalEffectsObservation = z.infer<typeof localEffectsObservationSchema>

/** Originating host attestation, not a physical-drain capability. */
export const boundedOwnerWitnessSchema = z.strictObject({
  kind: z.literal('sealed-no-entry'),
  hostContract: z.literal('trusted-preparation/1'),
  nativeAdmission: z.literal('not-entered'),
  correctionPlan: z.literal('not-entered'),
  driver: z.literal('joined'),
  publications: z.literal('joined'),
  git: z.literal('joined'),
  hostCallbacks: z.literal('joined'),
})
export type BoundedOwnerWitness = z.infer<typeof boundedOwnerWitnessSchema>

export const fixOwnerOpenedPayloadSchema = z.strictObject({
  format: z.literal(FIX_OWNER_FORMAT),
  phase: z.literal('opened'),
  common: ownerCommonSchema,
  intent: z.discriminatedUnion('kind', [freshIntakeIntentSchema, resumeDecisionIntentSchema]),
})
export type FixOwnerOpenedPayload = z.infer<typeof fixOwnerOpenedPayloadSchema>

export const fixOwnerSettledPayloadSchema = z.strictObject({
  format: z.literal(FIX_OWNER_FORMAT),
  phase: z.literal('settled'),
  opened: openedRefSchema,
  interrupted: interruptedPhaseSchema,
  admissionSealed: z.literal(true),
  outbound: z.array(outboundOperationSchema),
  witness: boundedOwnerWitnessSchema,
  local: localEffectsObservationSchema,
})
export type FixOwnerSettledPayload = z.infer<typeof fixOwnerSettledPayloadSchema>

export const fixOwnerPayloadSchema = z.discriminatedUnion('phase', [
  fixOwnerOpenedPayloadSchema,
  fixOwnerSettledPayloadSchema,
])
export type FixOwnerPayload = z.infer<typeof fixOwnerPayloadSchema>

export const legacyCorrectionBindingSchema = z.strictObject({
  phase: z.enum(['apply', 'falsify', 'restore-proof', 'revalidate']),
  causeId: identifierSchema,
  context: z.json(),
})
export type LegacyCorrectionBinding = z.infer<typeof legacyCorrectionBindingSchema>

export const slotCorrectionSchema = legacyCorrectionBindingSchema
export type SlotCorrection = z.infer<typeof slotCorrectionSchema>
