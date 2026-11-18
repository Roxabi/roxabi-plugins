import { z } from 'zod'
import { recordInputRefSchema } from './action-input-refs.ts'
import { nativeToolObservationSchema } from './native-tool-observation-schema.ts'
import { identifierSchema, sha256Schema } from './schema-primitives.ts'

export const contextEffectNegativeRefSchema = recordInputRefSchema.extend({
  record: recordInputRefSchema.shape.record.extend({ kind: z.literal('action-receipt') }),
  selector: z.literal('/payload'),
})

const conclusionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none-identified'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('unresolved'), reason: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('local-files'),
    resourceKeys: z.array(identifierSchema).min(1),
    reason: z.string().min(1),
  }),
])

export const contextLocalFileStateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({
    kind: z.literal('regular-file'),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    mode: z.number().int().min(0).max(0o7777),
  }),
])

export const contextEffectInventorySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unavailable') }),
  z.strictObject({ kind: z.literal('captured'), digest: sha256Schema }),
  z.strictObject({ kind: z.literal('partially-captured'), digest: sha256Schema }),
])

/** Proposed human attributions, not observations or a certificate of absence of effects. */
export const contextEffectIntentSchema = z.strictObject({
  format: z.literal('omp-build-context-effect-intent/1'),
  negatives: z
    .array(
      z.strictObject({
        source: contextEffectNegativeRefSchema,
        inventory: contextEffectInventorySchema,
        reportConclusion: conclusionSchema,
        calls: z.array(
          z.strictObject({
            childId: identifierSchema,
            sessionId: identifierSchema,
            ordinal: z.number().int().nonnegative(),
            toolCallId: identifierSchema,
            callDigest: sha256Schema,
            conclusion: conclusionSchema,
          }),
        ),
      }),
    )
    .min(1),
  resources: z.array(
    z.strictObject({
      key: identifierSchema,
      absolutePath: z.string().min(1),
      basis: z.literal('accept-named-state'),
      expected: contextLocalFileStateSchema,
    }),
  ),
})

/** Identifies one live observer lifetime, never a machine or the historical execution host. */
export const contextEffectNamespaceSchema = z.strictObject({
  kind: z.literal('confirmation-local-observer'),
  id: identifierSchema,
  sessionId: identifierSchema,
  agentId: identifierSchema,
})
const identitySchema = z.strictObject({ device: z.string().min(1), inode: z.string().min(1) })

export const contextLocalFileObservationSchema = z.strictObject({
  key: identifierSchema,
  namespaceId: identifierSchema,
  absolutePath: z.string().min(1),
  canonicalParent: z.string().min(1),
  leaf: z.string().min(1),
  ancestry: z.array(z.strictObject({ path: z.string().min(1), identity: identitySchema })).min(1),
  file: z
    .strictObject({ identity: identitySchema, modifiedNs: z.string().min(1), changedNs: z.string().min(1) })
    .nullable(),
  state: contextLocalFileStateSchema,
})

export const contextEffectSourcesSchema = z.array(
  z.strictObject({
    source: contextEffectNegativeRefSchema,
    inventory: contextEffectInventorySchema,
    observations: z.array(nativeToolObservationSchema),
  }),
)

export const contextEffectReviewSchema = z.strictObject({
  format: z.literal('omp-build-context-effect-review/1'),
  namespace: contextEffectNamespaceSchema,
  intent: contextEffectIntentSchema,
  sources: contextEffectSourcesSchema,
  resources: z.array(contextLocalFileObservationSchema),
})

export type ContextEffectIntent = z.infer<typeof contextEffectIntentSchema>
export type ContextEffectNamespace = z.infer<typeof contextEffectNamespaceSchema>
export type ContextLocalFileObservation = z.infer<typeof contextLocalFileObservationSchema>
export type ContextLocalFileState = z.infer<typeof contextLocalFileStateSchema>
export type ContextEffectSources = z.infer<typeof contextEffectSourcesSchema>
export type ContextEffectReview = z.infer<typeof contextEffectReviewSchema>
