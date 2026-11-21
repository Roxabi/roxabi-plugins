import { z } from 'zod'
import { specDigest } from './record-digests.ts'
import { type ExternalRecordRef, externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, jsonSchema, scopeSchema, sha256Schema, shaSchema } from './schema-primitives.ts'
import { nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import { criterionIdSchema, ownSpecRefSchema, specSnapshotSchema, uwTierSchema } from './uw-spec-schema.ts'
import { refinePopulatedParentCoverage } from './workflow-parent-coverage-refinement.ts'

const mandateConfigSchema = z.strictObject({
  productVersion: z.string().min(1),
  version: z.string().min(1),
  digest: sha256Schema,
  effective: jsonSchema,
})
const mandateOwnSpecSchema = z
  .strictObject({
    uw: scopeSchema,
    version: sha256Schema,
    snapshot: specSnapshotSchema,
    identityAllocations: z.array(externalRecordRefSchema),
  })
  .superRefine((value, context) => {
    if (value.snapshot.spec.version !== value.version)
      context.addIssue({ code: 'custom', path: ['version'], message: 'own Spec version does not match its snapshot' })
    if (specDigest(value.snapshot.raw.body) !== value.snapshot.raw.bodySha256)
      context.addIssue({
        code: 'custom',
        path: ['snapshot', 'raw', 'bodySha256'],
        message: 'own Spec raw body digest mismatch',
      })
    for (const [index, allocation] of value.identityAllocations.entries()) {
      if (allocation.kind !== 'spec-identity')
        context.addIssue({
          code: 'custom',
          path: ['identityAllocations', index, 'kind'],
          message: 'own Spec allocation must name a spec identity record',
        })
      if (allocation.scope.repository !== value.uw.repository || allocation.scope.target !== value.uw.target)
        context.addIssue({
          code: 'custom',
          path: ['identityAllocations', index, 'scope'],
          message: 'own Spec allocation must belong to its UW',
        })
    }
  })
export const acceptedChildCommitmentSchema = z
  .strictObject({
    scope: scopeSchema,
    specVersion: sha256Schema,
    snapshot: specSnapshotSchema,
    tier: uwTierSchema,
  })
  .superRefine((value, context) => {
    if (value.snapshot.spec.version !== value.specVersion)
      context.addIssue({ code: 'custom', path: ['specVersion'], message: 'child version does not match its snapshot' })
    if (specDigest(value.snapshot.raw.body) !== value.snapshot.raw.bodySha256)
      context.addIssue({
        code: 'custom',
        path: ['snapshot', 'raw', 'bodySha256'],
        message: 'child raw body digest mismatch',
      })
  })
export type AcceptedChildCommitment = z.infer<typeof acceptedChildCommitmentSchema>

export const parentCoverageSchema = z.strictObject({
  parent: z.strictObject({ uw: scopeSchema, version: sha256Schema }),
  assignments: z.array(
    z.strictObject({
      criterion: criterionIdSchema,
      children: z.tuple([scopeSchema]).rest(scopeSchema),
    }),
  ),
})
export type ParentCoverage = z.infer<typeof parentCoverageSchema>
export const concreteAcceptedStateSchema = z.strictObject({
  snapshot: specSnapshotSchema,
  tier: uwTierSchema,
  children: z.array(acceptedChildCommitmentSchema),
  inheritedOwnSpecRefs: z.array(ownSpecRefSchema),
  coverage: parentCoverageSchema.nullable(),
})
export type ConcreteAcceptedState = z.infer<typeof concreteAcceptedStateSchema>
export const createdChildBindingSchema = z.strictObject({
  slot: z.strictObject({ kind: z.literal('created-by'), operationId: identifierSchema }),
  child: scopeSchema,
  identity: externalRecordRefSchema.extend({ kind: z.literal('spec-identity') }),
  observed: nativeIssueObservationSchema,
  snapshot: specSnapshotSchema,
})
export type CreatedChildBinding = z.infer<typeof createdChildBindingSchema>
export const materialAuthorizationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct') }),
  z.strictObject({
    kind: z.literal('cause-creation'),
    operation: externalRecordRefSchema.extend({ kind: z.literal('cause-operation') }),
    binding: createdChildBindingSchema,
    boundState: concreteAcceptedStateSchema,
  }),
])
export type MaterialAuthorization = z.infer<typeof materialAuthorizationSchema>

export function refineParentCoverage(
  value: {
    own: {
      uw: { repository: string; target: string }
      version: string
      snapshot: { spec: { criteria: readonly { id: string }[] } }
    }
    children: readonly AcceptedChildCommitment[]
    coverage: ParentCoverage | null
  },
  context: z.RefinementCtx,
): void {
  if (value.children.length === 0) {
    if (value.coverage !== null)
      context.addIssue({ code: 'custom', path: ['coverage'], message: 'leaf must not declare parent coverage' })
    return
  }
  const coverage = value.coverage
  if (coverage === null) {
    context.addIssue({
      code: 'custom',
      path: ['coverage'],
      message: 'parent coverage is required for committed children',
    })
    return
  }
  refinePopulatedParentCoverage(value, coverage, context)
}

export function validParentCoverage(value: Parameters<typeof refineParentCoverage>[0]): boolean {
  return z
    .unknown()
    .superRefine((_input, context) => refineParentCoverage(value, context))
    .safeParse(null).success
}

const mandateShared = {
  format: z.literal('omp-build-mandate/4'),
  branch: z.string().min(1).nullable(),
  base: z.string().min(1),
  lineageHead: shaSchema.nullable(),
  config: mandateConfigSchema,
  parent: externalRecordRefSchema.nullable(),
  antecedent: externalRecordRefSchema.nullable(),
  ownSpec: mandateOwnSpecSchema,
  tier: uwTierSchema,
  children: z.array(acceptedChildCommitmentSchema),
  inheritedOwnSpecRefs: z.array(ownSpecRefSchema),
  coverage: parentCoverageSchema.nullable(),
}
const featureMandateSchema = z.strictObject({
  role: z.literal('feature'),
  ...mandateShared,
  run: z.string().regex(/^[a-z0-9]{8}$/),
  permissions: z.strictObject({ landing: z.literal(true), correct: z.literal(true) }),
})
const epicMandateSchema = z.strictObject({
  role: z.literal('epic'),
  ...mandateShared,
  run: z.string().regex(/^[a-z0-9]{8}$/),
  permissions: z.strictObject({ landing: z.boolean(), correct: z.boolean() }),
})
const fixOnlyMandateSchema = z.strictObject({
  role: z.literal('fix-only'),
  ...mandateShared,
  run: z.null(),
  permissions: z.strictObject({ landing: z.literal(false), correct: z.literal(true) }),
})

export function sameRefMeaning(refs: Array<ExternalRecordRef | null>, context: z.RefinementCtx): void {
  const seen = new Map<string, string>()
  for (const ref of refs) {
    if (ref === null) continue
    const key = `${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
    const prior = seen.get(key)
    if (prior !== undefined && prior !== ref.kind) {
      context.addIssue({
        code: 'custom',
        message: 'same scope and recordId must share one kind',
      })
    }
    seen.set(key, ref.kind)
  }
}

export const mandatePayloadSchema = z
  .discriminatedUnion('role', [featureMandateSchema, epicMandateSchema, fixOnlyMandateSchema])
  .superRefine((mandate, context) => {
    sameRefMeaning([...mandate.ownSpec.identityAllocations, mandate.parent, mandate.antecedent], context)
    refineParentCoverage({ own: mandate.ownSpec, children: mandate.children, coverage: mandate.coverage }, context)
    const children = new Set<string>()
    for (const [index, child] of mandate.children.entries()) {
      const key = `${child.scope.repository}\0${child.scope.target}`
      if (children.has(key))
        context.addIssue({ code: 'custom', path: ['children', index, 'scope'], message: 'child scope is repeated' })
      children.add(key)
    }
  })
export type MandatePayload = z.infer<typeof mandatePayloadSchema>

export const workflowBindingPayloadSchema = z
  .strictObject({
    mandate: externalRecordRefSchema,
    branch: z.string().min(1),
    base: z.string().min(1),
  })
  .superRefine((payload, context) => {
    if (payload.mandate.kind !== 'mandate') {
      context.addIssue({
        code: 'custom',
        path: ['mandate', 'kind'],
        message: 'workflow binding must name a mandate',
      })
    }
  })
export type WorkflowBindingPayload = z.infer<typeof workflowBindingPayloadSchema>
