import { z } from 'zod'
import { externalRecordRefSchema } from './record-references.ts'
import type { Diagnostic, Json } from './record-values.ts'
import { scopeSchema } from './record-values.ts'
import type { Result } from './result.ts'
import { specItemIdSchema } from './uw-spec-schema.ts'

const position = z.strictObject({ line: z.number().int().positive(), column: z.number().int().positive() })
export const uwLocationSchema = z.union([
  z.strictObject({
    kind: z.literal('body'),
    uw: scopeSchema,
    section: z.string().optional(),
    start: position,
    end: position,
  }),
  z.strictObject({
    kind: z.literal('spec'),
    uw: scopeSchema,
    path: z.array(z.union([z.string(), z.number().int()])),
    id: specItemIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('native'),
    uw: scopeSchema,
    connection: z.enum(['parent', 'children', 'blockers', 'labels', 'state']),
    cursor: z.string().optional(),
    page: z.number().int().positive().optional(),
  }),
  z.strictObject({ kind: z.literal('record'), ref: externalRecordRefSchema }),
])
export type UwLocation = z.infer<typeof uwLocationSchema>
export const uwDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  location: uwLocationSchema,
  related: z.array(uwLocationSchema),
})
export type UwDiagnostic = z.infer<typeof uwDiagnosticSchema>
export type UwResult<T> = Result<T, UwDiagnostic>
function encoded(location: UwLocation): Json {
  if (location.kind === 'record')
    return {
      kind: 'record',
      ref: {
        scope: { repository: location.ref.scope.repository, target: location.ref.scope.target },
        recordId: location.ref.recordId,
        kind: location.ref.kind,
      },
    }
  if (location.kind === 'spec')
    return {
      kind: 'spec',
      uw: { repository: location.uw.repository, target: location.uw.target },
      path: [...location.path],
      ...(location.id === undefined ? {} : { id: location.id }),
    }
  if (location.kind === 'native')
    return {
      kind: 'native',
      uw: { repository: location.uw.repository, target: location.uw.target },
      connection: location.connection,
      ...(location.cursor === undefined ? {} : { cursor: location.cursor }),
      ...(location.page === undefined ? {} : { page: location.page }),
    }
  return {
    kind: 'body',
    uw: { repository: location.uw.repository, target: location.uw.target },
    ...(location.section === undefined ? {} : { section: location.section }),
    start: location.start,
    end: location.end,
  }
}
function path(location: UwLocation): string {
  if (location.kind === 'record')
    return `${location.ref.scope.repository}#${location.ref.scope.target} record.${location.ref.recordId}`
  if (location.kind === 'spec') return `${location.uw.repository}#${location.uw.target} spec.${location.path.join('.')}`
  if (location.kind === 'native') return `${location.uw.repository}#${location.uw.target} native.${location.connection}`
  return `${location.uw.repository}#${location.uw.target} body:${location.start.line}:${location.start.column}`
}
export function toDiagnostic(value: UwDiagnostic): Diagnostic {
  return {
    code: value.code,
    message: value.message,
    path: path(value.location),
    detail: { uwLocation: encoded(value.location), related: value.related.map(encoded) },
  }
}
export function toDiagnostics(values: readonly UwDiagnostic[]): Diagnostic[] {
  return values.map(toDiagnostic)
}
