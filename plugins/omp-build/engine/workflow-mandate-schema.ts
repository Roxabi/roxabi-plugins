import { z } from 'zod'
import { specDigest } from './record-digests.ts'
import { type ExternalRecordRef, externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, jsonSchema, scopeSchema, sha256Schema, shaSchema } from './record-values.ts'

const mandateConfigSchema = z.strictObject({
  productVersion: z.string().min(1),
  version: z.string().min(1),
  digest: sha256Schema,
  effective: jsonSchema,
})
const mandateSpecSchema = z.strictObject({
  reference: z.string().min(1),
  body: z.string(),
  bodySha256: sha256Schema,
  lastEditedAt: z.string().min(1),
})
const approvedChildSchema = z.strictObject({
  scope: scopeSchema,
  specDigest: sha256Schema,
  specBody: z.string(),
})
const mandateShared = {
  format: z.literal('omp-build-mandate/2'),
  branch: z.string().min(1).nullable(),
  base: z.string().min(1),
  lineageHead: shaSchema.nullable(),
  config: mandateConfigSchema,
  parent: externalRecordRefSchema.nullable(),
  antecedent: externalRecordRefSchema.nullable(),
  spec: mandateSpecSchema,
}
const featureMandateSchema = z.strictObject({
  role: z.literal('feature'),
  ...mandateShared,
  run: z.null(),
  children: z.null(),
  permissions: z.strictObject({ landing: z.literal(true), correct: z.literal(true) }),
})
const epicMandateSchema = z.strictObject({
  role: z.literal('epic'),
  ...mandateShared,
  run: z.string().regex(/^[a-z0-9]{8}$/),
  children: z.array(approvedChildSchema),
  permissions: z.strictObject({ landing: z.boolean(), correct: z.boolean() }),
})
const fixOnlyMandateSchema = z.strictObject({
  role: z.literal('fix-only'),
  ...mandateShared,
  run: z.null(),
  children: z.null(),
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
    if (specDigest(mandate.spec.body) !== mandate.spec.bodySha256) {
      context.addIssue({ code: 'custom', path: ['spec', 'bodySha256'], message: 'spec body digest mismatch' })
    }
    sameRefMeaning([mandate.parent, mandate.antecedent], context)
    if (mandate.role !== 'epic') return
    const seenScopes = new Set<string>()
    for (const [index, child] of mandate.children.entries()) {
      const key = `${child.scope.repository}\0${child.scope.target}`
      if (seenScopes.has(key)) {
        context.addIssue({ code: 'custom', path: ['children', index, 'scope'], message: 'child scope is repeated' })
      }
      seenScopes.add(key)
      if (specDigest(child.specBody) !== child.specDigest) {
        context.addIssue({
          code: 'custom',
          path: ['children', index, 'specDigest'],
          message: 'child snapshot digest mismatch',
        })
      }
    }
  })
export type MandatePayload = z.infer<typeof mandatePayloadSchema>

const disarmSchema = z.strictObject({ observed: z.literal(true), evidence: jsonSchema })
const controlShared = { controlId: identifierSchema, mandate: externalRecordRefSchema }
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
      control: z.literal('accept-material'),
      predecessor: externalRecordRefSchema,
      assessment: externalRecordRefSchema,
      specDigest: sha256Schema,
      ...controlShared,
    }),
    z.strictObject({
      control: z.literal('select-successor'),
      predecessor: externalRecordRefSchema,
      successor: externalRecordRefSchema,
      ...controlShared,
    }),
  ])
  .superRefine((control, context) => {
    const refs: Array<ExternalRecordRef | null> = [control.mandate, control.predecessor]
    if (control.control === 'accept-material') refs.push(control.assessment)
    if (control.control === 'select-successor') refs.push(control.successor)
    sameRefMeaning(refs, context)
  })
export type OperatorControlPayload = z.infer<typeof operatorControlPayloadSchema>

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
