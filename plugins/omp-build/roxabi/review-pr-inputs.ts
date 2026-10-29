import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Policy, Result, Scope } from '../dist/contracts.js'
import { reviewActionId } from '../engine/review-context-lineage.ts'
import { parseRosterConfig, parseStackPaths } from '../skills/dev-review/roster-config'
import type { AllocateReviewInput } from '../skills/dev-review/roster-contract'
import { normalizeTier } from '../skills/dev-review/roster-spec'
import { validatePreparedReviewInput } from '../skills/feature/workflow-review-input.js'
import { actionRequest, codePin, type DeliveryCode, prepareRefusal } from './delivery-action.ts'
import { installedReviewSkillDir, loadReviewAssets, loadReviewClassCatalogue } from './review-assets'
import { candidateText } from './review-candidate-material'
import type {
  Git,
  GitResult,
  PreparedReviewChunk,
  PreparedReviewInputs,
  PrepareReviewInputsOptions,
} from './review-input-contract'
import { allocateReviewPanel } from './review-panel'
import { prepareReviewTarget, reviewMaterial } from './review-pr-target'
import { buildReviewPrompts, type SpecDisplay } from './review-prompts.ts'
import type { ReviewSemanticContext } from './review-semantic-context'
import type { ActionSubject, PreparedUwAction } from './uw-action-contract.ts'
import { parsePricedFences, specIsDraft } from './uw-spec/signals.ts'

const SIZE_VALUES: Record<string, true> = {
  s: true,
  xs: true,
  m: true,
  'f-lite': true,
  l: true,
  xl: true,
  'f-full': true,
}
const execFileAsync = promisify(execFile)
async function defaultGh(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(result.stdout).trim()
}
async function defaultGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (error) {
    const processError = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    return {
      code: typeof processError.code === 'number' ? processError.code : 1,
      stdout: processError.stdout ?? '',
      stderr: processError.stderr ?? message(error),
    }
  }
}
async function candidateHasAxialAdr(git: Git, cwd: string, candidate: string): Promise<boolean> {
  const paths = await git(cwd, ['ls-tree', '-r', '--name-only', candidate, '--', 'docs/architecture/adr'])
  if (paths.code !== 0) throw new Error(`candidate axial ADR discovery: ${paths.stderr || paths.stdout}`)
  for (const path of paths.stdout.split('\n')) {
    if (path.endsWith('.md') && /^axial:\s*true/m.test((await candidateText(git, cwd, candidate, path, true)) ?? ''))
      return true
  }
  return false
}
const failed = <T>(code: string, message: string): Result<T> => ({ ok: false, diagnostics: [{ code, message }] })
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
function tierDetails(issueSpec: PreparedReviewInputs['issueSpec']) {
  const warnings: string[] = []
  const labels = issueSpec?.labels.filter((label) => label.startsWith('size:')) ?? []
  const rawSize = labels[0]?.slice(5).trim() ?? ''
  const tier = normalizeTier(rawSize)
  if (issueSpec === null) warnings.push('no tracker issue reference — review tier defaults to F-lite')
  else if (!rawSize) warnings.push(`no size: label on #${issueSpec.number} — review tier defaults to F-lite`)
  else if (!Object.hasOwn(SIZE_VALUES, rawSize.toLowerCase())) {
    warnings.push(
      `size: label ${JSON.stringify(rawSize)} on #${issueSpec.number} is not canonical — review tier defaults to F-lite`,
    )
  }
  if (labels.length > 1) {
    warnings.push(`tracker issue #${issueSpec?.number} has multiple size labels; using ${labels[0]}`)
  }
  return { tier, warnings }
}

function reviewSubject(scope: Scope, semantic: ReviewSemanticContext): ActionSubject {
  if (semantic.mode === 'standalone') return { kind: 'standalone-pr', pullRequest: scope }
  return { kind: 'uw', uw: semantic.binding.scope, pullRequest: scope, binding: null }
}

function trackerSnapshot(issueSpec: PreparedReviewInputs['issueSpec']) {
  if (issueSpec === null) return null
  return { reference: issueSpec.reference, body: issueSpec.body, lastEditedAt: issueSpec.lastEditedAt }
}

function assignedPanelChunk(name: string, chunks: readonly PreparedReviewChunk[]): number | null {
  const match = /^panel-(\d+)-(.+)$/.exec(name)
  if (match === null) return null
  const index = Number(match[1])
  return chunks.some((chunk) => chunk.index === index) ? index : null
}

async function confirmReviewActions(
  options: PrepareReviewInputsOptions,
  candidate: string,
  scope: Scope,
  semanticContext: ReviewSemanticContext,
  code: DeliveryCode,
  chunks: readonly PreparedReviewChunk[],
  taskNames: readonly string[],
  captureInput: string | null,
): Promise<Result<Record<string, PreparedUwAction>>> {
  const subject = reviewSubject(scope, semanticContext)
  const projection = {
    contextWindow: options.contextWindow,
    chunks,
  }
  const descriptors: { name: string; assignedChunk: number | null }[] = [{ name: 'spec', assignedChunk: null }]
  for (const name of taskNames) {
    const assignedChunk = assignedPanelChunk(name, chunks)
    if (assignedChunk === null) return failed('review-action-unprepared', `panel task names an absent chunk: ${name}`)
    descriptors.push({ name, assignedChunk })
  }
  const prepared = await options.operations.prepareReviewActions({
    actions: descriptors.map(({ name, assignedChunk }) => ({
      request: actionRequest({
        actionId: reviewActionId(candidate, name, options.expansion?.expandedContext ?? []),
        purpose: 'review',
        subject,
        code,
        ...options.expansion,
      }),
      projection: { ...projection, taskName: name, assignedChunk },
    })),
  })
  if (!prepared.ok)
    return failed(prepareRefusal(prepared.diagnostics), prepared.diagnostics.map((item) => item.message).join('; '))
  const specAction = prepared.value[0]
  if (specAction === undefined || prepared.value.length !== descriptors.length)
    return failed('review-action-unprepared', 'Initial review batch is incomplete')
  const actions: Record<string, PreparedUwAction> = {}
  for (const [index, descriptor] of descriptors.entries()) {
    const action = prepared.value[index]
    if (action === undefined || action.inputs.fingerprint !== specAction.inputs.fingerprint)
      return failed('review-input-changed', 'spec and panel fingerprints diverged')
    actions[descriptor.name] = action
  }
  if (options.expansion === undefined && captureInput !== null && captureInput !== specAction.inputs.fingerprint) {
    return failed('review-input-changed', 'captured review digest does not match the prepared action fingerprint')
  }
  return { ok: true, value: actions }
}

/** Read-only producer preparation: exact capture, raw candidate bytes, roster and prompts; no dispatch/write. */
export async function prepareReviewInputs(options: PrepareReviewInputsOptions): Promise<Result<PreparedReviewInputs>> {
  if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) {
    return failed('invalid-context-window', 'review contextWindow must be a positive integer')
  }
  const gh = options.gh ?? defaultGh
  const git = options.git ?? defaultGit
  try {
    return await prepareCapturedReviewInputs(options, gh, git)
  } catch (error) {
    return failed('review-input-preparation-failed', message(error))
  }
}

async function prepareCapturedReviewInputs(
  options: PrepareReviewInputsOptions,
  gh: (cwd: string, args: string[]) => Promise<string>,
  git: Git,
): Promise<Result<PreparedReviewInputs>> {
  const target = await prepareReviewTarget(options.cwd, options.pr, gh, git, options.pluginPin)
  if (!target.ok) return target
  const { number, repository, automationLogin, candidate, pr, semanticContext, capture } = target.value
  const issueSpec = semanticContext.currentSpec
  const { tier, warnings } = tierDetails(issueSpec)
  const catalogue = loadReviewClassCatalogue(installedReviewSkillDir(options.pluginPin))
  const { assetDir, canonicalClasses, config } = catalogue
  if (!canonicalClasses.length) {
    return failed('review-class-catalogue-invalid', 'installed class catalogue has no canonical classes')
  }
  const material = await reviewMaterial(options, git, gh, candidate, pr.base, assetDir)
  if (!material.ok) return material
  const { refreshed, stack, baseStack, chunks } = material.value
  const parsed = issueSpec === null ? { claims: [], pricedClaimOk: true } : parsePricedFences(issueSpec.body)
  if (!parsed.pricedClaimOk) {
    return failed('priced-fence-invalid', 'tracker issue has a priced fence without a valid claim')
  }
  const rosterConfig = parseRosterConfig(stack)
  rosterConfig.warnings.push(...warnings)
  const roster: AllocateReviewInput['shared'] = {
    delta: chunks.flatMap((chunk) => chunk.delta),
    tier,
    chunks: chunks.length,
    claims: parsed.claims,
    pricedClaimOk: parsed.pricedClaimOk,
    specDraft: issueSpec !== null && specIsDraft(issueSpec.body),
    axialAdr: await candidateHasAxialAdr(git, options.cwd, candidate),
    stackPaths: parseStackPaths(stack),
    config: rosterConfig,
  }
  const policy: Policy = { version: 'baseline' }
  const spec: SpecDisplay =
    issueSpec === null
      ? { source: 'absent', issue: null, body: null, rows: [] }
      : { source: 'tracker-issue', issue: issueSpec.number, body: issueSpec.body, rows: [] }
  const loadedAssets = loadReviewAssets(catalogue)
  const assets = {
    classes: loadedAssets.classes,
    evidencePolicy: loadedAssets.evidencePolicy,
    rootCauses: loadedAssets.rootCauses,
    smells: loadedAssets.smells,
    blindSpots: loadedAssets.blindSpots,
  }
  const scope = { repository, target: `${repository}#${number}` }
  const pinned = codePin(repository, refreshed.tip, candidate, candidate)
  if (!pinned.ok) return failed('code-unobserved', 'review code pins are not observed SHAs')
  const panel = allocateReviewPanel({
    chunks,
    roster,
    config: { ...config, canonicalClasses },
    commonContext: 'review',
  })
  const actions = await confirmReviewActions(
    options,
    candidate,
    scope,
    semanticContext,
    pinned.code,
    chunks,
    panel.tasks.map((task) => task.name),
    capture.input,
  )
  if (!actions.ok) return actions
  const specAction = actions.value.spec
  if (options.expansion !== undefined) {
    const validation = await validatePreparedReviewInput(options.cwd, number, candidate, specAction.inputs, {
      gh,
      git,
      automationLogin,
      pluginPin: options.pluginPin,
    })
    if (!validation.ok) return failed('review-input-changed', validation.error)
  }
  return {
    ok: true,
    value: {
      scope,
      context: {
        ...scope,
        number,
        candidateGitSHA: candidate,
        input: specAction.inputs.fingerprint,
        subject: { kind: 'pull-request' },
      },
      pr: { number, head: candidate, base: pr.base, baseGitSHA: refreshed.tip, branch: pr.branch },
      automationLogin,
      capture,
      observedEvidence: {
        reviewInput: capture.input,
        candidate: { head: candidate, base: refreshed.tip },
        pullRequest: capture.body,
        stack: { candidate: stack, base: baseStack },
        resolvedSpec: trackerSnapshot(issueSpec),
        semanticContext,
      },
      inputSnapshot: specAction.inputs,
      issueSpec,
      semanticContext,
      tier,
      warnings: rosterConfig.warnings,
      chunks,
      contextWindow: options.contextWindow,
      roster,
      config: { ...config, canonicalClasses },
      policy,
      semantic: {
        assets,
        spec,
        prompts: buildReviewPrompts({
          tier,
          policy,
          spec,
          semanticContext,
          semanticCanon: capture.semanticCanon,
          assets,
        }),
      },
      actions: actions.value,
      operations: options.operations,
      rawOperatorRequest: { pullRequest: { number, body: pr.body }, trackerIssue: trackerSnapshot(issueSpec) },
    },
  }
}
