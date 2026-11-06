import { z } from 'zod'
import { observationRefSchema } from './criterion-evidence-schema.ts'
import { externalRecordRefSchema } from './record-references.ts'
import { identifierSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import { ownSpecRefSchema } from './uw-spec-schema.ts'

const ref = <K extends string>(kind: K) => externalRecordRefSchema.extend({ kind: z.literal(kind) })
export const causeDependencyNativePlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('update-blockers'), remove: z.array(scopeSchema), add: z.array(scopeSchema) }),
])
export type CauseDependencyNativePlan = z.infer<typeof causeDependencyNativePlanSchema>
export const causeDependencyAdjustmentProposalSchema = z.strictObject({
  format: z.literal('omp-build-cause-dependency-adjustment/1'),
  operationId: identifierSchema,
  controlId: identifierSchema,
  origin: scopeSchema,
  mandate: ref('mandate'),
  accepted: ownSpecRefSchema,
  versionVector: z.tuple([ownSpecRefSchema]).rest(ownSpecRefSchema),
  disposition: ref('cause-disposition'),
  receipt: ref('debt-receipt'),
  predecessor: z.union([ref('debt-receipt'), ref('operator-control')]),
  change: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('withdraw') }),
    z.strictObject({ kind: z.literal('replace'), blocker: scopeSchema }),
  ]),
  reason: z.string().trim().min(1),
  references: z.array(observationRefSchema),
  before: nativeIssueObservationSchema,
  nativeObservationDigest: sha256Schema,
  histories: z.array(z.strictObject({ scope: scopeSchema, digest: sha256Schema })),
  nativeGraph: z.strictObject({
    root: scopeSchema,
    rows: z.array(z.strictObject({ uw: scopeSchema, digest: sha256Schema })),
  }),
  nativeEffect: causeDependencyNativePlanSchema,
})
export type CauseDependencyAdjustmentProposal = z.infer<typeof causeDependencyAdjustmentProposalSchema>
export type PreparedCauseDependencyAdjustment = { proposal: CauseDependencyAdjustmentProposal; digest: string }
