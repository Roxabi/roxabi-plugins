type OverrideDiagnostic = { code: string; message: string }
type ParsedWorkflowOverride =
  | { ok: true; additionalRequirements: string[] }
  | { ok: false; reason: 'unsupported' | 'unreadable'; diagnostics: OverrideDiagnostic[] }

function overrideDiagnostic(code: string, message: string): OverrideDiagnostic {
  return { code, message }
}

function unreadableOverride(error: unknown): ParsedWorkflowOverride {
  return {
    ok: false,
    reason: 'unreadable',
    diagnostics: [overrideDiagnostic('unreadable', error instanceof Error ? error.message : String(error))],
  }
}

function unsupportedOverride(message: string): ParsedWorkflowOverride {
  return { ok: false, reason: 'unsupported', diagnostics: [overrideDiagnostic('unsupported', message)] }
}

function isConfigObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

export function parseWorkflowOverride(text: string | null): ParsedWorkflowOverride {
  if (text === null) return { ok: true, additionalRequirements: [] }
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (error) {
    return unreadableOverride(error)
  }
  if (!isConfigObject(parsed)) return unsupportedOverride('committed stack.yml is not an object')
  const review = 'review' in parsed ? parsed.review : undefined
  if (review == null) return { ok: true, additionalRequirements: [] }
  if (!isConfigObject(review)) return unsupportedOverride('stack.yml review is not an object')
  if ('graph' in review || 'workflow' in review)
    return unsupportedOverride('stack.yml must not carry a project workflow graph')
  const requirements = 'additional_requirements' in review ? review.additional_requirements : undefined
  if (requirements == null) return { ok: true, additionalRequirements: [] }
  if (!nonEmptyStringList(requirements))
    return unsupportedOverride('review.additional_requirements must be non-empty strings')
  return { ok: true, additionalRequirements: [...requirements] }
}
