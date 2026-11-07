import { type Json, jsonSchema } from './schema-primitives.ts'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Preserve readable structured output even when the SDK terminal reports a failure. */
export function inspectNativeTerminal(value: unknown): { structured: Json | null; reason: string | null } {
  if (!object(value)) return { structured: null, reason: 'malformed-child-result' }
  const output = value.structuredOutput
  const parsed = object(output) && output.status === 'valid' ? jsonSchema.safeParse(output.data) : null
  const structured = parsed?.success ? parsed.data : null
  let reason: string | null = null
  if (value.exitCode !== 0) reason = 'required-child-exit-code'
  else if (value.error !== undefined && value.error !== null) reason = 'required-child-error'
  else if (value.aborted === true) reason = 'required-child-aborted'
  else if (!object(output)) reason = 'missing-structured-output'
  else if (output.status !== 'valid') reason = 'structured-output-not-valid'
  return { structured, reason }
}
