import { z } from 'zod'
import { FINDING_TARGET_FORMAT } from './finding-target-schema.ts'
import { equalScope, sameOwnSpecRef } from './record-diagnostics.ts'
import { exclusionRefSchema, invariantIdSchema, ownSpecRefSchema, specSchema } from './uw-spec-schema.ts'

export const SPEC_EFFECTIVE_FORMAT = 'omp-build-spec-effective/2' as const

export const specEffectiveSchema = z
  .strictObject({
    format: z.literal(SPEC_EFFECTIVE_FORMAT),
    resolution: z.literal('resolved'),
    own: ownSpecRefSchema,
    versionVector: z.tuple([ownSpecRefSchema]).rest(ownSpecRefSchema),
    spec: specSchema,
    inherited: z.strictObject({
      invariants: z.array(
        z.strictObject({
          target: z.strictObject({
            format: z.literal(FINDING_TARGET_FORMAT),
            kind: z.literal('invariant'),
            spec: ownSpecRefSchema,
            id: invariantIdSchema,
          }),
          statement: z.string().min(1),
        }),
      ),
      exclusions: z.array(z.strictObject({ ref: exclusionRefSchema, statement: z.string() })),
    }),
  })
  .superRefine((value, context) => {
    if (value.own.version !== value.spec.version || !sameOwnSpecRef(value.versionVector[0], value.own))
      context.addIssue({
        code: 'custom',
        path: ['versionVector'],
        message: 'effective Spec must begin with its exact own accepted version',
      })
    const scopes = new Set<string>()
    for (const [index, ref] of value.versionVector.entries()) {
      const key = `${ref.uw.repository}\0${ref.uw.target}`
      if (scopes.has(key))
        context.addIssue({
          code: 'custom',
          path: ['versionVector', index],
          message: 'effective Spec repeats an ancestor scope',
        })
      scopes.add(key)
    }
    for (const [index, inherited] of value.inherited.invariants.entries()) {
      if (!value.versionVector.slice(1).some((ref) => sameOwnSpecRef(ref, inherited.target.spec)))
        context.addIssue({
          code: 'custom',
          path: ['inherited', 'invariants', index],
          message: 'invariant must identify a pinned ancestor',
        })
    }
    for (const [index, inherited] of value.inherited.exclusions.entries()) {
      if (!value.versionVector.slice(1).some((ref) => sameOwnSpecRef(ref, inherited.ref.spec)))
        context.addIssue({
          code: 'custom',
          path: ['inherited', 'exclusions', index],
          message: 'exclusion must identify a pinned ancestor',
        })
    }
    if (!equalScope(value.own.uw, value.own.sourceAccepted.scope))
      context.addIssue({
        code: 'custom',
        path: ['own', 'sourceAccepted'],
        message: 'own accepted source must belong to its UW',
      })
  })
export type SpecEffective = z.infer<typeof specEffectiveSchema>
