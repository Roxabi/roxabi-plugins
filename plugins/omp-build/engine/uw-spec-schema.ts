import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import { scopeSchema, sha256Schema } from './schema-primitives.ts'
export const SPEC_CONTENT_FORMAT = 'omp-build-spec-content/1' as const
const ordinalSchema = z.string().regex(/^[1-9][0-9]*$/)
export const criterionIdSchema = z.templateLiteral(['C', ordinalSchema])
export const invariantIdSchema = z.templateLiteral(['I', ordinalSchema])
export const specItemIdSchema = z.union([criterionIdSchema, invariantIdSchema])
export type CriterionId = z.infer<typeof criterionIdSchema>
export type InvariantId = z.infer<typeof invariantIdSchema>
export type SpecItemId = z.infer<typeof specItemIdSchema>
export const uwTierSchema = z.enum(['S', 'F-lite', 'F-full'])
export type UwTier = z.infer<typeof uwTierSchema>
const sections = z.strictObject({ origin: z.string(), context: z.string(), change: z.string() })
const item = <T extends z.ZodType<string>>(id: T) => z.strictObject({ id, statement: z.string().min(1) })
function unique(items: readonly { id: string }[], context: z.RefinementCtx, path: string): void {
  const seen = new Set<string>()
  items.forEach((value, index) => {
    if (seen.has(value.id))
      context.addIssue({ code: 'custom', path: [path, index, 'id'], message: `Duplicate Spec ID ${value.id}` })
    seen.add(value.id)
  })
}
const specContentBaseSchema = z.strictObject({
  format: z.literal(SPEC_CONTENT_FORMAT),
  criteria: z.array(item(criterionIdSchema)),
  invariants: z.array(item(invariantIdSchema)),
  exclusions: z.array(z.string()),
  openQuestions: z.array(z.string()),
  sections,
})
const checkUniqueSpecIds = (
  value: { criteria: readonly { id: string }[]; invariants: readonly { id: string }[] },
  context: z.RefinementCtx,
): void => {
  unique(value.criteria, context, 'criteria')
  unique(value.invariants, context, 'invariants')
}
export const specContentSchema = specContentBaseSchema.superRefine(checkUniqueSpecIds)
export type SpecContent = z.infer<typeof specContentSchema>
export const specSchema = specContentBaseSchema.extend({ version: sha256Schema }).superRefine(checkUniqueSpecIds)
export type Spec = z.infer<typeof specSchema>
export type SpecVersion = Spec['version']
const draftItem = <K extends z.ZodType<string>>(id: K) =>
  z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), id, statement: z.string().min(1) }),
    z.strictObject({ kind: z.literal('new'), draftKey: z.string().min(1), statement: z.string().min(1) }),
  ])
export const specDraftSchema = z
  .strictObject({
    criteria: z.array(draftItem(criterionIdSchema)),
    invariants: z.array(draftItem(invariantIdSchema)),
    exclusions: z.array(z.string()),
    openQuestions: z.array(z.string()),
    sections,
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    ;[...value.criteria, ...value.invariants].forEach((item, index) => {
      if (item.kind === 'new' && seen.has(item.draftKey))
        context.addIssue({ code: 'custom', path: [index, 'draftKey'], message: `Duplicate draft key ${item.draftKey}` })
      if (item.kind === 'new') seen.add(item.draftKey)
    })
  })
export type SpecDraft = z.infer<typeof specDraftSchema>
export type DraftItem<K extends SpecItemId> = Extract<
  z.infer<typeof specDraftSchema>['criteria'][number] | z.infer<typeof specDraftSchema>['invariants'][number],
  { id: K } | { kind: 'new' }
>
export const specRawSourceSchema = z.strictObject({
  reference: z.string().min(1),
  body: z.string(),
  bodySha256: sha256Schema,
  lastEditedAt: z.string().nullable(),
})
export type SpecRawSource = z.infer<typeof specRawSourceSchema>
export const specSnapshotSchema = z.strictObject({ spec: specSchema, raw: specRawSourceSchema })
export type SpecSnapshot = { spec: Spec; raw: SpecRawSource }
export const ownSpecRefSchema = z.strictObject({
  uw: scopeSchema,
  version: sha256Schema,
  sourceAccepted: externalRecordRefSchema,
})
export type OwnSpecRef = z.infer<typeof ownSpecRefSchema>
export const exclusionRefSchema = z.strictObject({
  spec: ownSpecRefSchema,
  index: z.number().int().nonnegative(),
})
export type ExclusionRef = z.infer<typeof exclusionRefSchema>
