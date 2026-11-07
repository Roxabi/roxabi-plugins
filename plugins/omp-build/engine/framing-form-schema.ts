import { z } from 'zod'
import {
  framingAccountedDecisionSchema,
  framingCoverageIntentSchema,
  framingDestinationMergeSchema,
  framingEdgeSchema,
  framingMemberKeySchema,
  framingObligationSchema,
} from './uw-framing-schema.ts'
import { complexityFactorsSchema, tierOverrideSchema } from './uw-normalization-schema.ts'
import { specDraftSchema } from './uw-spec-schema.ts'

const decision = z.strictObject({
  questionEntryId: z.string().min(1),
  answerEntryId: z.string().min(1),
  decision: z.string().trim().min(1),
})
const decisions = z.array(decision)
const unresolved = z.array(z.string().trim().min(1))
const term = z.strictObject({ term: z.string().trim().min(1), meaning: z.string().trim().min(1) })
const selectedText = z.union([z.literal('accepted-args'), z.strictObject({ entryId: z.string().min(1) })])
/** Model slots carry only member keys and operator-visible reference tokens; the host resolves every Scope. */
const modelSlot = z.discriminatedUnion('kind', [
  z.strictObject({ key: framingMemberKeySchema, kind: z.literal('new') }),
  z.strictObject({ key: framingMemberKeySchema, kind: z.literal('selected') }),
  z.strictObject({
    key: framingMemberKeySchema,
    kind: z.literal('native-child'),
    parent: framingMemberKeySchema,
    reference: z.string().min(1),
  }),
])
const modelMember = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('uw'),
    slot: modelSlot,
    draft: specDraftSchema,
    title: z.string().trim().min(1),
    factors: complexityFactorsSchema,
    tierOverride: tierOverrideSchema,
    normalization: z.array(framingAccountedDecisionSchema),
    merges: z.array(framingDestinationMergeSchema),
    labels: z.strictObject({ add: z.array(z.string()), remove: z.array(z.string()) }),
  }),
  z.strictObject({
    kind: z.literal('wayfinder'),
    slot: modelSlot,
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
/** Typed conclusions bound to root draft obligations; they are structure, not semantic proof. */
const vocabularyBinding = z.strictObject({
  term: z.string().trim().min(1),
  invariant: framingObligationSchema,
  criterion: framingObligationSchema,
})
const moduleBinding = z.strictObject({ name: z.string().trim().min(1), invariant: framingObligationSchema })
export const framingFormSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('question'), question: z.string().trim().min(1) }),
  z.strictObject({
    kind: z.literal('grilling'),
    decisions,
    unresolved,
    shape: z.enum(['parent', 'leaf']),
    terms: z.array(term),
  }),
  z.strictObject({ kind: z.literal('terminology'), decisions, unresolved, terms: z.array(term) }),
  z.strictObject({
    kind: z.literal('module-design'),
    decisions,
    unresolved,
    modules: z.array(
      z.strictObject({
        name: z.string().trim().min(1),
        interface: z.string().trim().min(1),
        seam: z.string().trim().min(1),
      }),
    ),
  }),
  z.strictObject({
    kind: z.literal('material'),
    producer: z.enum(['to-spec', 'to-tickets']),
    entry: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('select-existing'),
    key: framingMemberKeySchema,
    text: selectedText,
    reference: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('answer-only'), answer: z.string().trim().min(1) }),
  z.strictObject({ kind: z.literal('wayfinder-offer'), question: z.string().trim().min(1) }),
  z.strictObject({
    kind: z.literal('proposal'),
    aggregate: z.strictObject({
      kind: z.enum(['uw', 'wayfinder']),
      root: framingMemberKeySchema,
      members: z.array(modelMember).min(1),
      edges: z.array(framingEdgeSchema),
      coverage: z.array(framingCoverageIntentSchema),
      foundations: z.array(z.strictObject({ parent: framingMemberKeySchema, child: framingMemberKeySchema })),
    }),
    decisions,
    vocabulary: z.array(vocabularyBinding),
    modules: z.array(moduleBinding),
  }),
])
export type FramingForm = z.infer<typeof framingFormSchema>
export const framingFormInputSchema = z.strictObject({ supplyToken: z.string().min(1), form: framingFormSchema })
export type FramingFormInput = z.infer<typeof framingFormInputSchema>
