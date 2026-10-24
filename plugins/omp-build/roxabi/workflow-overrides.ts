import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { installedProductVersion, workflowConfigDigest } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'

const OVERRIDE_PATH = '.dev/stack.yml'
const execFileAsync = promisify(execFile)

type OverrideDiagnostic = { code: string; message: string }
type ParsedWorkflowOverride =
  | { ok: true; additionalRequirements: string[] }
  | { ok: false; reason: 'unsupported' | 'unreadable'; diagnostics: OverrideDiagnostic[] }

/** Approved effective requirements only. Current defaults are not substituted. */
export function additionalRequirementsOf(effective: unknown): string[] {
  if (effective === null || typeof effective !== 'object' || Array.isArray(effective)) return []
  if (!('additionalRequirements' in effective) || !Array.isArray(effective.additionalRequirements)) return []
  return effective.additionalRequirements.every((item) => typeof item === 'string' && item.length > 0)
    ? [...effective.additionalRequirements]
    : []
}

export function acceptanceCriteria(body: string): string[] {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => /^#{1,6}\s+acceptance criteria\s*$/i.test(line.trim()))
  if (start < 0) return []
  const items: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+/.test(line.trim())) break
    const item = /^[-*]\s+(.+)$/.exec(line.trim())
    if (item?.[1]) items.push(item[1].trim())
  }
  return items
}

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

function commandErrorText(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    return error.stderr
  }
  return error instanceof Error ? error.message : String(error)
}

async function committedOverride(repo: string, commit: string): Promise<string | null> {
  try {
    const shown = await execFileAsync('git', ['show', `${commit}:${OVERRIDE_PATH}`], { cwd: repo, encoding: 'utf8' })
    return shown.stdout
  } catch (error) {
    const stderr = commandErrorText(error)
    if (/does not exist|exists on disk, but not in|invalid object name/.test(stderr)) return null
    throw error
  }
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

type ValidEffectiveConfig = { requirements: string[]; productVersion: unknown }

function validateEffectiveConfig(
  effective: unknown,
): { ok: true; config: ValidEffectiveConfig } | { ok: false; error: string } {
  if (!isConfigObject(effective)) return { ok: false, error: 'effective config is not an object' }
  if (!('compatibility' in effective) || effective.compatibility !== WORKFLOW_CONFIG_VERSION) {
    return { ok: false, error: 'effective compatibility is not supported' }
  }
  if (!('graphDigest' in effective) || effective.graphDigest !== workflowConfigDigest()) {
    return { ok: false, error: 'effective graph digest does not match the installed graph' }
  }
  if (!('additionalRequirements' in effective) || !stringList(effective.additionalRequirements)) {
    return { ok: false, error: 'effective additionalRequirements are not strings' }
  }
  return {
    ok: true,
    config: {
      requirements: effective.additionalRequirements,
      productVersion: 'productVersion' in effective ? effective.productVersion : undefined,
    },
  }
}

async function readCommittedOverride(
  repo: string,
): Promise<{ ok: true; text: string | null } | { ok: false; error: string }> {
  try {
    return { ok: true, text: await committedOverride(repo, 'HEAD') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function productVersionError(productVersion: unknown): string | null {
  if (typeof productVersion !== 'string' || productVersion === installedProductVersion()) return null
  return 'effective productVersion does not match the installed plugin package'
}

/** Mandate effective config against the committed checkout. Working-tree copies are not read. */
export async function configCompatibility(
  repo: string,
  effective: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const validated = validateEffectiveConfig(effective)
  if (!validated.ok) return validated
  const current = await readCommittedOverride(repo)
  if (!current.ok) return current
  const committed = parseWorkflowOverride(current.text)
  if (!committed.ok) return { ok: false, error: committed.diagnostics.map((item) => item.message).join('; ') }
  const requirementsMatch =
    validated.config.requirements.length === committed.additionalRequirements.length &&
    validated.config.requirements.every((item, index) => item === committed.additionalRequirements[index])
  if (!requirementsMatch) {
    return { ok: false, error: 'committed workflow override does not match the mandate effective config' }
  }
  const versionError = productVersionError(validated.config.productVersion)
  return versionError === null ? { ok: true } : { ok: false, error: versionError }
}
