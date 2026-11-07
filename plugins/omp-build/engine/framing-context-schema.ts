import { z } from 'zod'
import { pinnedFileRefSchema } from './action-input-refs.ts'
import { pluginPinSchema } from './action-input-schema.ts'
import { sha256Schema } from './schema-primitives.ts'

export const FRAMING_PROCEDURE_FILES = {
  grilling: 'skills/feature/framing-procedures/grilling.md',
  'domain-modeling': 'skills/feature/framing-procedures/domain-modeling.md',
  'codebase-design': 'skills/feature/framing-procedures/codebase-design.md',
} as const

export const framingStageSchema = z.enum(['grilling', 'domain-modeling', 'codebase-design'])
export type FramingStage = z.infer<typeof framingStageSchema>

export const framingProcedureManifestSchema = z.strictObject({
  format: z.literal('omp-build-framing-procedures/1'),
  plugin: pluginPinSchema,
  procedures: z.tuple([
    z.strictObject({ stage: z.literal('grilling'), file: pinnedFileRefSchema }),
    z.strictObject({ stage: z.literal('domain-modeling'), file: pinnedFileRefSchema }),
    z.strictObject({ stage: z.literal('codebase-design'), file: pinnedFileRefSchema }),
  ]),
  digest: sha256Schema,
})
export type FramingProcedureManifest = z.infer<typeof framingProcedureManifestSchema>

export const framingInvocationBindingSchema = z.strictObject({
  extensionInstanceId: z.string().min(1),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  sourceDigest: sha256Schema,
  procedures: framingProcedureManifestSchema,
})
export type FramingInvocationBinding = z.infer<typeof framingInvocationBindingSchema>
