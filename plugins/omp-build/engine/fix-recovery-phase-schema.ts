import { z } from 'zod'
import { partPinSchema, recordPinSchema, reservedRecordIdentitySchema } from './fix-recovery-identities.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'

const openedRefSchema = externalRecordRefSchema.extend({ kind: z.literal('fix-owner') })
const recoveryRefSchema = externalRecordRefSchema.extend({ kind: z.literal('fix-recovery') })
const scopeKey = (scope: z.infer<typeof scopeSchema>) => `${scope.repository}\0${scope.target}`

const closeRecoveryRefSchema = recoveryRefSchema
export const freshIntakeIntentSchema = z.strictObject({
  kind: z.literal('fresh-intake'),
  afterClose: closeRecoveryRefSchema.nullable(),
  sourceReservation: reservedRecordIdentitySchema('contribution'),
  requestReservation: reservedRecordIdentitySchema('fix-request'),
})
export const resumeDecisionIntentSchema = z.strictObject({
  kind: z.literal('resume-decision'),
  recovery: recoveryRefSchema,
  source: recordPinSchema('contribution'),
  request: recordPinSchema('fix-request'),
  decision: recordPinSchema('decision'),
})

export const unconfirmedPublicationSchema = <K extends string>(kind: K) =>
  z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('not-submitted'), reservation: reservedRecordIdentitySchema(kind) }),
    z.strictObject({
      state: z.literal('submitted-unconfirmed'),
      reservation: reservedRecordIdentitySchema(kind),
      observedParts: z.array(partPinSchema),
    }),
  ])

const contributionPublicationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('not-submitted'),
    reservation: reservedRecordIdentitySchema('contribution'),
  }),
  z.strictObject({
    state: z.literal('submitted-unconfirmed'),
    reservation: reservedRecordIdentitySchema('contribution'),
    observedParts: z.array(partPinSchema),
  }),
  z.strictObject({ state: z.literal('complete'), record: recordPinSchema('contribution') }),
])

const fixRequestUnconfirmedSchema = unconfirmedPublicationSchema('fix-request')
const decisionUnconfirmedSchema = z.union([
  unconfirmedPublicationSchema('decision'),
  z.strictObject({ state: z.literal('not-reserved') }),
])

export const publicationPrefixPhaseSchema = z.strictObject({
  kind: z.literal('publication-prefix'),
  opened: openedRefSchema,
  source: contributionPublicationSchema,
  request: fixRequestUnconfirmedSchema,
})
export const requestBeforeDecisionPhaseSchema = z.strictObject({
  kind: z.literal('request-before-decision'),
  opened: openedRefSchema,
  source: recordPinSchema('contribution'),
  request: recordPinSchema('fix-request'),
  decision: decisionUnconfirmedSchema,
})
export const decidedPhaseSchema = z.strictObject({
  kind: z.literal('decided'),
  opened: openedRefSchema,
  source: recordPinSchema('contribution'),
  request: recordPinSchema('fix-request'),
  decision: recordPinSchema('decision'),
})
export const interruptedPhaseSchema = z.discriminatedUnion('kind', [
  publicationPrefixPhaseSchema,
  requestBeforeDecisionPhaseSchema,
  decidedPhaseSchema,
])
export type InterruptedPhase = z.infer<typeof interruptedPhaseSchema>

const ownedKindSchema = z.enum([
  'review-attempt',
  'contribution',
  'decision',
  'review',
  'fix-request',
  'fix-result',
  'correction-result',
  'falsification-result',
  'debt-receipt',
  'cause-disposition',
  'cause-operation',
  'report-promotion',
  'stop',
  'action-receipt',
  'operator-control',
])

export const reservedOwnedIdentitySchema = z.strictObject({
  scope: scopeSchema,
  kind: ownedKindSchema,
  runId: identifierSchema,
  operationId: identifierSchema,
  recordId: identifierSchema,
})

const outboundPublicationSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('reserved') }),
  z.strictObject({ state: z.literal('submitted-unconfirmed'), observedParts: z.array(partPinSchema) }),
  z.strictObject({
    state: z.literal('confirmed'),
    record: z.strictObject({
      identity: reservedOwnedIdentitySchema,
      envelopeDigest: sha256Schema,
      parts: z.array(partPinSchema).min(1),
    }),
  }),
])

export const outboundOperationSchema = z
  .strictObject({
    identity: reservedOwnedIdentitySchema,
    publication: outboundPublicationSchema,
  })
  .superRefine((value, context) => {
    if (value.publication.state === 'confirmed') {
      const identity = value.publication.record.identity
      if (
        identity.kind !== value.identity.kind ||
        identity.runId !== value.identity.runId ||
        identity.operationId !== value.identity.operationId ||
        identity.recordId !== value.identity.recordId ||
        scopeKey(identity.scope) !== scopeKey(value.identity.scope)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['publication', 'record', 'identity'],
          message: 'Confirmed outbound pin must match the reserved identity',
        })
      }
    }
  })
export type OutboundOperation = z.infer<typeof outboundOperationSchema>
