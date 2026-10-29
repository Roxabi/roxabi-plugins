import { z } from 'zod'
import { unframedParserSchema } from './issue-spec-analysis-schema.ts'
import { externalRecordRefSchema, gitObjectIdSchema } from './record-references.ts'
import { repoRelativePathSchema, scopeSchema, sha256Schema } from './schema-primitives.ts'
import { specEffectiveSchema } from './spec-effective.ts'
import { specRawSourceSchema, specSnapshotSchema } from './uw-spec-schema.ts'

export const ACTION_INPUT_FORMAT = 'omp-build-action-input/1' as const
export const ACTION_BINDING_FORMAT = 'omp-build-action-input-binding/1' as const

const jsonPointerSchema = z.string().regex(/^(?:\/(?:[^/~]|~0|~1)*)+$/)
export const recordInputRefSchema = z.strictObject({
  source: z.literal('record'),
  record: externalRecordRefSchema,
  selector: jsonPointerSchema,
  digest: sha256Schema,
})
export type RecordInputRef = z.infer<typeof recordInputRefSchema>
export const pinnedFileRefSchema = z.strictObject({
  source: z.literal('git-file'),
  repository: z.string().min(1),
  commit: gitObjectIdSchema,
  path: repoRelativePathSchema,
  digest: sha256Schema,
})
export type PinnedFileRef = z.infer<typeof pinnedFileRefSchema>
export const deliveryDataRefSchema = recordInputRefSchema.extend({
  role: z.enum([
    'plan',
    'plan-review',
    'implementation',
    'criterion-evidence',
    'correction-lineage',
    'external-observation',
  ]),
})
export type DeliveryDataRef = z.infer<typeof deliveryDataRefSchema>
export const actionPurposeSchema = z.enum([
  'frame',
  'assess-spec',
  'plan',
  'plan-review',
  'implement',
  'attribute-ci',
  'review',
  'correction',
  'normalize',
])
export type ActionPurpose = z.infer<typeof actionPurposeSchema>
export const actionSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('uw'),
    uw: scopeSchema,
    pullRequest: scopeSchema.nullable(),
    binding: recordInputRefSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('standalone-pr'), pullRequest: scopeSchema }),
])
export type ActionSubject = z.infer<typeof actionSubjectSchema>
export const actionSpecInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('accepted'), effective: specEffectiveSchema }),
  z.strictObject({ kind: z.literal('proposed'), uw: scopeSchema, snapshot: specSnapshotSchema }),
  z.strictObject({
    kind: z.literal('unframed'),
    uw: scopeSchema,
    source: specRawSourceSchema,
    parser: unframedParserSchema,
  }),
  z.strictObject({ kind: z.literal('absent'), reason: z.literal('standalone-review') }),
])
export type ActionSpecInput = z.infer<typeof actionSpecInputSchema>

const codeRefSchema = z.strictObject({
  repository: z.string().min(1),
  base: gitObjectIdSchema,
  head: gitObjectIdSchema,
  referenceCommit: gitObjectIdSchema,
})
const pluginPinSchema = z.strictObject({
  name: z.literal('omp-build'),
  version: z.string().min(1),
  repository: z.string().min(1),
  commit: gitObjectIdSchema,
  root: repoRelativePathSchema,
  files: z.array(pinnedFileRefSchema),
})

function sameScope(
  left: { repository: string; target: string },
  right: { repository: string; target: string },
): boolean {
  return left.repository === right.repository && left.target === right.target
}

const actionInputManifestObject = z.strictObject({
  format: z.literal(ACTION_INPUT_FORMAT),
  purpose: actionPurposeSchema,
  subject: actionSubjectSchema,
  spec: actionSpecInputSchema,
  code: codeRefSchema,
  acceptedSources: z.array(recordInputRefSchema),
  deliveryData: z.array(deliveryDataRefSchema),
  repositoryReferences: z.array(pinnedFileRefSchema),
  plugin: pluginPinSchema,
  configuration: z.strictObject({
    version: z.string().min(1),
    digest: sha256Schema,
    serialized: z.string().min(1),
  }),
  expandedContext: z.array(z.union([recordInputRefSchema, pinnedFileRefSchema])),
})
type ActionInputManifestValue = z.infer<typeof actionInputManifestObject>

function manifestIssue(context: z.RefinementCtx, path: (string | number)[], message: string): void {
  context.addIssue({ code: 'custom', path, message })
}

function refineSourcePurpose(value: ActionInputManifestValue, context: z.RefinementCtx): void {
  const { purpose, spec } = value
  if (spec.kind === 'unframed' && purpose !== 'frame' && purpose !== 'normalize') {
    manifestIssue(context, ['spec'], 'unframed source is lawful only for frame or normalize')
  }
  if (spec.kind === 'proposed' && purpose !== 'frame' && purpose !== 'normalize' && purpose !== 'assess-spec') {
    manifestIssue(context, ['spec'], 'proposed snapshot is lawful only for frame, normalize, or assess-spec')
  }
  if (spec.kind === 'accepted' && (purpose === 'frame' || purpose === 'normalize')) {
    manifestIssue(context, ['spec'], 'frame and normalize cannot carry an accepted Spec')
  }
  if (
    spec.kind === 'absent' &&
    ((purpose !== 'review' && purpose !== 'correction') || value.subject.kind !== 'standalone-pr')
  ) {
    manifestIssue(context, ['spec'], 'absent Spec is lawful only for standalone review or correction')
  }
}

function refineSubjectScope(value: ActionInputManifestValue, context: z.RefinementCtx): void {
  const { spec, subject } = value
  if (spec.kind === 'accepted' && subject.kind !== 'uw') {
    manifestIssue(context, ['subject'], 'accepted Spec requires a UW subject')
  }
  if (
    (spec.kind === 'proposed' || spec.kind === 'unframed') &&
    subject.kind === 'uw' &&
    !sameScope(spec.uw, subject.uw)
  ) {
    manifestIssue(context, ['spec', 'uw'], 'source UW does not match the action subject')
  }
  if (spec.kind === 'accepted' && subject.kind === 'uw' && !sameScope(spec.effective.own.uw, subject.uw)) {
    manifestIssue(context, ['spec', 'effective'], 'accepted Spec UW does not match the action subject')
  }
}

function refinePluginPins(value: ActionInputManifestValue, context: z.RefinementCtx): void {
  value.plugin.files.forEach((file, index) => {
    if (file.repository !== value.plugin.repository || file.commit !== value.plugin.commit) {
      manifestIssue(context, ['plugin', 'files', index], 'plugin file pin does not match the installed plugin commit')
    }
  })
}

export const actionInputManifestSchema = actionInputManifestObject.superRefine((value, context) => {
  refineSourcePurpose(value, context)
  refineSubjectScope(value, context)
  refinePluginPins(value, context)
})
export type ActionInputManifest = z.infer<typeof actionInputManifestSchema>
export const actionInputsSchema = z.strictObject({
  format: z.literal(ACTION_BINDING_FORMAT),
  manifest: actionInputManifestSchema,
  fingerprint: sha256Schema,
  stageSources: z.array(recordInputRefSchema),
})
export type ActionInputs = z.infer<typeof actionInputsSchema>
