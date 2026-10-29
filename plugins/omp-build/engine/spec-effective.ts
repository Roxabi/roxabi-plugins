import { z } from 'zod'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { type OwnSpecRef, ownSpecRefSchema, specSchema } from './uw-spec-schema.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

export const SPEC_EFFECTIVE_FORMAT = 'omp-build-spec-effective/1' as const

export function sameOwnSpecRef(left: OwnSpecRef, right: OwnSpecRef): boolean {
  return (
    left.version === right.version &&
    left.uw.repository === right.uw.repository &&
    left.uw.target === right.uw.target &&
    left.sourceAccepted.recordId === right.sourceAccepted.recordId &&
    left.sourceAccepted.kind === right.sourceAccepted.kind &&
    left.sourceAccepted.scope.repository === right.sourceAccepted.scope.repository &&
    left.sourceAccepted.scope.target === right.sourceAccepted.scope.target
  )
}

export const specEffectiveSchema = z
  .strictObject({
    format: z.literal(SPEC_EFFECTIVE_FORMAT),
    resolution: z.literal('own-only'),
    own: ownSpecRefSchema,
    versionVector: z.tuple([ownSpecRefSchema]),
    spec: specSchema,
    ancestry: z.literal('not-resolved'),
  })
  .superRefine((value, context) => {
    if (value.own.version !== value.spec.version) {
      context.addIssue({
        code: 'custom',
        path: ['own', 'version'],
        message: 'effective Spec version does not match own ref',
      })
    }
    if (!sameOwnSpecRef(value.versionVector[0], value.own)) {
      context.addIssue({
        code: 'custom',
        path: ['versionVector'],
        message: 'own-only version vector must equal own',
      })
    }
    if (value.own.uw.repository.length === 0 || value.own.uw.target.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['own', 'uw'],
        message: 'effective Spec scope must identify the exact UW',
      })
    }
  })
export type SpecEffective = z.infer<typeof specEffectiveSchema>

function refused(code: string, message: string): Result<SpecEffective> {
  const diagnostic: Diagnostic = { code, message }
  return { ok: false, diagnostics: [diagnostic] }
}

/** Own-only projection. Never reports an empty ancestor list as resolved inheritance. */
export function resolveOwnSpecEffective(accepted: AcceptedOwnSpec): Result<SpecEffective> {
  const own = accepted.ref
  if (own.version !== accepted.snapshot.spec.version) {
    return refused('mismatch', `Accepted Spec ${own.uw.target} version does not match its snapshot`)
  }
  if (own.uw.repository.length === 0 || own.uw.target.length === 0) {
    return refused('malformed', 'Accepted Spec scope does not identify the exact UW')
  }
  const parsed = specEffectiveSchema.safeParse({
    format: SPEC_EFFECTIVE_FORMAT,
    resolution: 'own-only',
    own,
    versionVector: [own],
    spec: accepted.snapshot.spec,
    ancestry: 'not-resolved',
  })
  return parsed.success
    ? { ok: true, value: parsed.data }
    : refused('malformed', 'Accepted own Spec is not an own-only effective Spec')
}
