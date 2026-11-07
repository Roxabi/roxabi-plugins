import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import { scopeSchema, sha256Schema } from './schema-primitives.ts'
import {
  complexityFactorsSchema,
  normalizationDecisionSchema,
  sourceSpanSchema,
  tierOverrideSchema,
} from './uw-normalization-schema.ts'
import { specDraftSchema, specItemIdSchema, specRawSourceSchema } from './uw-spec-schema.ts'
import { repositorySchema } from './uw-write-intent-schema.ts'

export const framingMemberKeySchema = z.string().min(1)
export type FramingMemberKey = z.infer<typeof framingMemberKeySchema>
export const framingMaterialIdSchema = z.string().regex(/^m[1-9][0-9]*$/)
export type FramingMaterialId = z.infer<typeof framingMaterialIdSchema>
export const framingMaterialCaptureSchema = z.strictObject({
  id: framingMaterialIdSchema,
  producer: z.enum(['to-spec', 'to-tickets']),
  origin: z.strictObject({
    kind: z.literal('operator-entry'),
    sessionId: z.string().min(1),
    entryId: z.string().min(1),
  }),
  raw: specRawSourceSchema,
})
export type FramingMaterialCapture = z.infer<typeof framingMaterialCaptureSchema>
export const framingSourceOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native'), member: framingMemberKeySchema }),
  z.strictObject({ kind: z.literal('material'), id: framingMaterialIdSchema }),
])
export type FramingSourceOrigin = z.infer<typeof framingSourceOriginSchema>
export const framingAccountedDecisionSchema = z
  .strictObject({ origin: framingSourceOriginSchema.nullable(), decision: normalizationDecisionSchema })
  .superRefine((value, ctx) => {
    if ((value.decision.kind === 'new') !== (value.origin === null))
      ctx.addIssue({ code: 'custom', message: 'New decisions alone have no source origin' })
  })
export type FramingAccountedDecision = z.infer<typeof framingAccountedDecisionSchema>
export const framingObligationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), id: specItemIdSchema }),
  z.strictObject({ kind: z.literal('new'), draftKey: z.string().min(1) }),
])
export const framingSourceRefSchema = z.strictObject({ origin: framingSourceOriginSchema, span: sourceSpanSchema })
export const framingDestinationMergeSchema = z.strictObject({
  target: framingObligationSchema,
  sources: z.array(framingSourceRefSchema).min(2),
  reason: z.string().trim().min(1),
})
export type FramingDestinationMerge = z.infer<typeof framingDestinationMergeSchema>
export const framingSlotSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), reference: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('operator-reference'),
    text: z.union([
      z.literal('accepted-args'),
      z.strictObject({ sessionId: z.string().min(1), entryId: z.string().min(1) }),
    ]),
    reference: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('native-child'), parent: framingMemberKeySchema, reference: z.string().min(1) }),
])
export type FramingSlotSelection = z.infer<typeof framingSlotSelectionSchema>
export const framingMemberSlotSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('existing'),
    key: framingMemberKeySchema,
    uw: scopeSchema,
    sourceBodySha256: sha256Schema,
    selection: framingSlotSelectionSchema,
    observed: z.strictObject({
      nativeParent: scopeSchema.nullable(),
      children: z.array(scopeSchema),
      blockers: z.array(scopeSchema),
    }),
  }),
  z.strictObject({ kind: z.literal('new'), key: framingMemberKeySchema, repository: repositorySchema }),
])
export type FramingMemberSlot = z.infer<typeof framingMemberSlotSchema>
export const framingEdgeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('parent-child'), parent: framingMemberKeySchema, child: framingMemberKeySchema }),
  z.strictObject({ kind: z.literal('blocker'), dependent: framingMemberKeySchema, blocker: framingMemberKeySchema }),
])
export type FramingEdge = z.infer<typeof framingEdgeSchema>
export const framingCoverageIntentSchema = z.strictObject({
  parent: framingMemberKeySchema,
  assignments: z.array(
    z.strictObject({ criterion: framingObligationSchema, children: z.array(framingMemberKeySchema).min(1) }),
  ),
})
export type FramingCoverageIntent = z.infer<typeof framingCoverageIntentSchema>
export const framingSourceBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('free-text'),
    acceptedArgs: z.string().min(1),
    bodySha256: sha256Schema,
    repository: repositorySchema,
    materials: z.array(framingMaterialCaptureSchema),
  }),
  z.strictObject({
    kind: z.literal('issue'),
    uw: scopeSchema,
    body: specRawSourceSchema,
    parserDigest: sha256Schema,
    nativeDigest: sha256Schema,
    ledgerHead: externalRecordRefSchema.nullable(),
    historyDigest: sha256Schema,
    engagementDigest: sha256Schema,
    materials: z.array(framingMaterialCaptureSchema),
  }),
])
export type FramingSourceBinding = z.infer<typeof framingSourceBindingSchema>
export const framingMemberSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('uw'),
    slot: framingMemberSlotSchema,
    draft: specDraftSchema,
    title: z.string().trim().min(1),
    factors: complexityFactorsSchema,
    tierOverride: tierOverrideSchema,
    normalization: z.array(framingAccountedDecisionSchema),
    merges: z.array(framingDestinationMergeSchema),
    labels: z.strictObject({ add: z.array(z.string().min(1)), remove: z.array(z.string().min(1)) }),
  }),
  z.strictObject({
    kind: z.literal('wayfinder'),
    slot: framingMemberSlotSchema,
    title: z.string().trim().min(1),
    body: z.string(),
    label: z.enum([
      'wayfinder:map',
      'wayfinder:grilling',
      'wayfinder:research',
      'wayfinder:prototype',
      'wayfinder:task',
    ]),
  }),
])
export type FramingUwMember = Extract<z.infer<typeof framingMemberSchema>, { kind: 'uw' }>
export type FramingNonUwMember = Extract<z.infer<typeof framingMemberSchema>, { kind: 'wayfinder' }>
export const framingAggregateInputSchema = z
  .strictObject({
    kind: z.enum(['uw', 'wayfinder']),
    root: framingMemberKeySchema,
    members: z.array(framingMemberSchema).min(1),
    edges: z.array(framingEdgeSchema),
    coverage: z.array(framingCoverageIntentSchema),
    foundations: z.array(z.strictObject({ parent: framingMemberKeySchema, child: framingMemberKeySchema })),
    source: framingSourceBindingSchema,
  })
  .superRefine((value, ctx) => {
    const members = new Map(value.members.map((member) => [member.slot.key, member]))
    if (members.size !== value.members.length)
      ctx.addIssue({ code: 'custom', path: ['members'], message: 'Member keys must be unique' })
    const root = members.get(value.root)
    if (!root || root.kind !== value.kind)
      ctx.addIssue({ code: 'custom', path: ['root'], message: 'Root must name a member of the aggregate kind' })
    for (const [index, edge] of value.edges.entries()) {
      const endpoints = edge.kind === 'parent-child' ? [edge.parent, edge.child] : [edge.dependent, edge.blocker]
      if (endpoints[0] === endpoints[1] || endpoints.some((key) => members.get(key)?.kind !== 'uw'))
        ctx.addIssue({ code: 'custom', path: ['edges', index], message: 'Edges require two distinct UW members' })
    }
  })
export type FramingAggregateInput = z.infer<typeof framingAggregateInputSchema>
