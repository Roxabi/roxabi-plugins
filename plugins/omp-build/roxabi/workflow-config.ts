import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/**
 * Shipped Roxabi lifecycle data. The engine validates this graph and is the
 * only traversal. This module does not match edges.
 */
export const WORKFLOW_CONFIG_VERSION = 'omp-build-workflow/1'
export const SUPPORTED_CONFIG_VERSIONS = [WORKFLOW_CONFIG_VERSION] as const

export const PROOF_PIN_PATHS = ['.semctx/config.json', 'assertledger.config.json', '.dev/stack.yml'] as const

const SHA = /^[0-9a-f]{40}$/
/**
 * Project overrides stay on the existing committed stack path.
 * Prefer this over an optional `.omp-build/workflow.json`:
 * - `.dev/stack.yml` is already the trusted base/landing/proof pin source;
 * - one committed reader avoids a second project config that could drift or
 *   smuggle a graph copy;
 * - allowlist is only `review.additional_requirements` strings (never graph,
 *   bounds, or admission). Absent `review` means no extra requirements.
 */
const OVERRIDE_PATH = '.dev/stack.yml'
const execFileAsync = promisify(execFile)

export type WorkflowGraphAction =
  | 'frame'
  | 'assess-spec'
  | 'plan'
  | 'implement'
  | 'publish'
  | 'proof'
  | 'review'
  | 'fix'
  | 'attribute-ci'
  | 'land'
  | 'epic-next'
  | 'epic-final'
  | 'mark-fix'
  | 'hook'
  | 'report'
  | 'stop'
  | 'done'

export type WorkflowCondition =
  | 'always'
  | 'no-mandate'
  | 'mandate-ready'
  | 'spec-differs'
  | 'spec-settled'
  | 'plan-confirmed'
  | 'implement-confirmed'
  | 'pr-open'
  | 'proof-confirmed'
  | 'review-step-review'
  | 'review-step-fix'
  | 'review-step-land'
  | 'review-step-stop'
  | 'fix-confirmed'
  | 'ci-red'
  | 'ci-attributed-change'
  | 'ci-attribution-refused'
  | 'merged'
  | 'end-obligations-met'
  | 'epic-start'
  | 'epic-resume'
  | 'epic-stop'
  | 'epic-final-review'
  | 'epic-fix-ticket'
  | 'epic-post-merge'
  | 'epic-complete'
  | 'epic-drop'

export type WorkflowGraph = {
  version: 1
  productVersion: string
  configVersion: string
  edgeOrder: 'array'
  nodes: { id: string; action: WorkflowGraphAction }[]
  edges: { from: string; to: string; when: WorkflowCondition }[]
  initial: string
}

export type ProofConfigPin = { sourceCommit: string; path: string; blob: string | null }

export type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export type EffectiveWorkflowConfig = {
  compatibility: typeof WORKFLOW_CONFIG_VERSION
  additionalRequirements: string[]
  graphDigest: string
  graph: WorkflowGraph
  productVersion: string
}

const NODES: WorkflowGraph['nodes'] = [
  { id: 'ready', action: 'stop' },
  { id: 'frame', action: 'frame' },
  { id: 'assess-spec', action: 'assess-spec' },
  { id: 'plan', action: 'plan' },
  { id: 'implement', action: 'implement' },
  { id: 'publish', action: 'publish' },
  { id: 'proof', action: 'proof' },
  { id: 'review', action: 'review' },
  { id: 'fix', action: 'fix' },
  { id: 'attribute-ci', action: 'attribute-ci' },
  { id: 'land', action: 'land' },
  // Watch attachment is owned by `land` (featureLandOutcome start-watch /
  // reattach-watch). A separate watch node had no incoming edge and is removed
  // rather than inventing a fake condition.
  { id: 'epic-next', action: 'epic-next' },
  { id: 'epic-final', action: 'epic-final' },
  { id: 'mark-fix', action: 'mark-fix' },
  { id: 'hook', action: 'hook' },
  { id: 'report', action: 'report' },
  { id: 'stop', action: 'stop' },
  { id: 'done', action: 'done' },
]

/** One edge per condition. Array order is shipped data the engine validates, not a second matcher. */
const EDGES: WorkflowGraph['edges'] = [
  { from: 'ready', to: 'stop', when: 'ci-attribution-refused' },
  { from: 'ready', to: 'stop', when: 'epic-stop' },
  { from: 'ready', to: 'report', when: 'epic-drop' },
  { from: 'ready', to: 'report', when: 'epic-complete' },
  { from: 'ready', to: 'epic-final', when: 'epic-final-review' },
  { from: 'ready', to: 'mark-fix', when: 'epic-fix-ticket' },
  { from: 'ready', to: 'hook', when: 'epic-post-merge' },
  { from: 'ready', to: 'epic-next', when: 'epic-start' },
  { from: 'ready', to: 'epic-next', when: 'epic-resume' },
  { from: 'ready', to: 'attribute-ci', when: 'ci-red' },
  { from: 'ready', to: 'fix', when: 'ci-attributed-change' },
  { from: 'ready', to: 'stop', when: 'review-step-stop' },
  { from: 'ready', to: 'fix', when: 'review-step-fix' },
  { from: 'ready', to: 'land', when: 'review-step-land' },
  { from: 'ready', to: 'review', when: 'review-step-review' },
  { from: 'ready', to: 'done', when: 'end-obligations-met' },
  { from: 'ready', to: 'hook', when: 'merged' },
  { from: 'ready', to: 'review', when: 'fix-confirmed' },
  { from: 'ready', to: 'review', when: 'proof-confirmed' },
  { from: 'ready', to: 'proof', when: 'pr-open' },
  { from: 'ready', to: 'publish', when: 'implement-confirmed' },
  { from: 'ready', to: 'implement', when: 'plan-confirmed' },
  { from: 'ready', to: 'assess-spec', when: 'spec-differs' },
  { from: 'ready', to: 'plan', when: 'spec-settled' },
  { from: 'ready', to: 'plan', when: 'mandate-ready' },
  { from: 'ready', to: 'frame', when: 'no-mandate' },
  { from: 'ready', to: 'stop', when: 'always' },
]

export function shippedWorkflowGraph(productVersion: string): WorkflowGraph {
  if (productVersion.length === 0) throw new Error('workflow graph requires the shipped product version')
  return {
    version: 1,
    productVersion,
    configVersion: WORKFLOW_CONFIG_VERSION,
    edgeOrder: 'array',
    nodes: NODES.map((node) => ({ ...node })),
    edges: EDGES.map((edge) => ({ ...edge })),
    initial: 'ready',
  }
}

/** Key-sorted JSON. Array order stays meaningful. Undefined fields are omitted so codec read-back matches. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export type ConfigPin = {
  compatibility: string
  additionalRequirements: readonly string[]
  graphDigest: string
  graph: WorkflowGraph
  productVersion: string
}

/** Digest of the complete serialized effective configuration pin. */
export function configPinDigest(effective: ConfigPin): string {
  return createHash('sha256').update(canonicalJson(effective)).digest('hex')
}

/**
 * Fact for the engine. Not a record and not a pass inferred from zero proof records.
 * `applicable-noop` is the existing admission where both producers do not apply and
 * the current review-input binding was captured. Ignored-local and missing committed
 * config stay blocked. A missing decision is `not-run`.
 */
export type ProofGraphOutcome =
  | { status: 'not-run' }
  | {
      status: 'blocked'
      reason:
        | 'ignored-local'
        | 'missing-committed-config'
        | 'unreadable'
        | 'ambiguous'
        | 'unbound'
        | 'missing'
        | 'verdict'
        | 'unjustified'
    }
  | {
      status: 'applicable-noop'
      inputBound: true
      reviewInput: string
      semctx: 'absent'
      assertledger: 'not-applicable'
    }
  | {
      status: 'requires-record'
      inputBound: true
      reviewInput: string
      semctx: 'configured' | 'absent'
      assertledger: 'detection' | 'not-applicable'
    }
  | {
      status: 'admitted'
      inputBound: true
      reviewInput: string
      semctx: 'absent' | 'verified' | 'partial'
      assertledger: 'not-applicable' | 'detection'
    }

/** Digest of the shipped edge table. Product version is not part of the digest. */
export function workflowConfigDigest(): string {
  return createHash('sha256')
    .update(canonicalJson({ version: WORKFLOW_CONFIG_VERSION, nodes: NODES, edges: EDGES }))
    .digest('hex')
}

export function installedProductVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
  )
  if (parsed === null || typeof parsed !== 'object' || !('version' in parsed) || typeof parsed.version !== 'string') {
    throw new Error('omp-build package version is missing')
  }
  if (parsed.version.length === 0) throw new Error('omp-build package version is empty')
  return parsed.version
}

export function effectiveWorkflowConfig(
  productVersion: string,
  additionalRequirements: readonly string[],
): EffectiveWorkflowConfig {
  return {
    compatibility: WORKFLOW_CONFIG_VERSION,
    additionalRequirements: [...additionalRequirements],
    graphDigest: workflowConfigDigest(),
    graph: shippedWorkflowGraph(productVersion),
    productVersion,
  }
}

export async function readProofConfigPins(git: GitRunner, toplevel: string, commit: string): Promise<ProofConfigPin[]> {
  const resolved = await git(toplevel, ['rev-parse', '--verify', `${commit}^{commit}`])
  const sourceCommit = resolved.stdout.trim()
  if (resolved.code !== 0 || !SHA.test(sourceCommit)) {
    throw new Error(`proof pin source ${commit} is not a commit`)
  }
  const pins: ProofConfigPin[] = []
  for (const path of PROOF_PIN_PATHS) {
    const listed = await git(toplevel, ['rev-parse', '--verify', '--quiet', `${sourceCommit}:${path}`])
    const blob = listed.stdout.trim()
    pins.push({
      sourceCommit,
      path,
      blob: listed.code === 0 && SHA.test(blob) ? blob : null,
    })
  }
  return pins
}

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

function overrideDiagnostic(code: string, message: string): { code: string; message: string } {
  return { code, message }
}

export function parseWorkflowOverride(
  text: string | null,
):
  | { ok: true; additionalRequirements: string[] }
  | { ok: false; reason: 'unsupported' | 'unreadable'; diagnostics: { code: string; message: string }[] } {
  if (text === null) return { ok: true, additionalRequirements: [] }
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(text)
  } catch (error) {
    return {
      ok: false,
      reason: 'unreadable',
      diagnostics: [overrideDiagnostic('unreadable', error instanceof Error ? error.message : String(error))],
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'unsupported',
      diagnostics: [overrideDiagnostic('unsupported', 'committed stack.yml is not an object')],
    }
  }
  if (!('review' in parsed) || parsed.review == null) return { ok: true, additionalRequirements: [] }
  const review = parsed.review
  if (review === null || typeof review !== 'object' || Array.isArray(review)) {
    return {
      ok: false,
      reason: 'unsupported',
      diagnostics: [overrideDiagnostic('unsupported', 'stack.yml review is not an object')],
    }
  }
  if ('graph' in review || 'workflow' in review) {
    return {
      ok: false,
      reason: 'unsupported',
      diagnostics: [overrideDiagnostic('unsupported', 'stack.yml must not carry a project workflow graph')],
    }
  }
  if (!('additional_requirements' in review) || review.additional_requirements == null) {
    return { ok: true, additionalRequirements: [] }
  }
  const requirements = review.additional_requirements
  if (!Array.isArray(requirements) || requirements.some((item) => typeof item !== 'string' || item.length === 0)) {
    return {
      ok: false,
      reason: 'unsupported',
      diagnostics: [overrideDiagnostic('unsupported', 'review.additional_requirements must be non-empty strings')],
    }
  }
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

export async function readEffectiveFixConfig(input: {
  cwd: string
  commit: string
  git: GitRunner
}): Promise<
  | { ok: true; version: string; digest: string; effective: EffectiveWorkflowConfig }
  | { ok: false; reason: 'unsupported' | 'unreadable'; diagnostics: { code: string; message: string }[] }
> {
  const shown = await input.git(input.cwd, ['show', `${input.commit}:${OVERRIDE_PATH}`])
  const missing = shown.code !== 0 && /does not exist|exists on disk, but not in|invalid object/.test(shown.stderr)
  if (shown.code !== 0 && !missing) {
    return {
      ok: false,
      reason: 'unreadable',
      diagnostics: [overrideDiagnostic('unreadable', shown.stderr.trim() || 'workflow override is unreadable')],
    }
  }
  const parsed = parseWorkflowOverride(missing ? null : shown.stdout)
  if (!parsed.ok) return parsed
  const effective = effectiveWorkflowConfig(installedProductVersion(), parsed.additionalRequirements)
  return {
    ok: true,
    version: WORKFLOW_CONFIG_VERSION,
    digest: configPinDigest(effective),
    effective,
  }
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index])
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Mandate effective config against the committed checkout. Working-tree copies are not read. */
export async function configCompatibility(
  repo: string,
  effective: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (effective === null || typeof effective !== 'object' || Array.isArray(effective)) {
    return { ok: false, error: 'effective config is not an object' }
  }
  if (!('compatibility' in effective) || effective.compatibility !== WORKFLOW_CONFIG_VERSION) {
    return { ok: false, error: 'effective compatibility is not supported' }
  }
  if (!('graphDigest' in effective) || effective.graphDigest !== workflowConfigDigest()) {
    return { ok: false, error: 'effective graph digest does not match the installed graph' }
  }
  if (!('additionalRequirements' in effective) || !stringList(effective.additionalRequirements)) {
    return { ok: false, error: 'effective additionalRequirements are not strings' }
  }
  let text: string | null
  try {
    text = await committedOverride(repo, 'HEAD')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const committed = parseWorkflowOverride(text)
  if (!committed.ok) return { ok: false, error: committed.diagnostics.map((item) => item.message).join('; ') }
  if (!sameList(effective.additionalRequirements, committed.additionalRequirements)) {
    return { ok: false, error: 'committed workflow override does not match the mandate effective config' }
  }
  if (
    'productVersion' in effective &&
    typeof effective.productVersion === 'string' &&
    effective.productVersion !== installedProductVersion()
  ) {
    return { ok: false, error: 'effective productVersion does not match the installed plugin package' }
  }
  return { ok: true }
}
