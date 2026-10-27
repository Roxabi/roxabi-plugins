import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Policy, Result } from '../dist/contracts.js'
import { parseRosterConfig, parseStackPaths } from '../skills/dev-review/roster-config'
import type { AllocateReviewInput } from '../skills/dev-review/roster-contract'
import { normalizeTier } from '../skills/dev-review/roster-spec'
import { refreshReviewBase } from '../skills/feature/review-base'
import { loadReviewAssets, loadReviewClassCatalogue, loadReviewConfig } from './review-assets'
import { candidateText, materializeCandidateChunks } from './review-candidate-material'
import type {
  Git,
  GitResult,
  PreparedReviewInputs,
  PrepareReviewInputsOptions,
  ReviewInputCapture,
} from './review-input-contract'
import { prepareReviewTarget } from './review-pr-target'
import { buildReviewPrompts, type SpecDisplay } from './review-prompts'
import { parsePricedFences, specIsDraft } from './uw-spec'

const SHA = /^[0-9a-f]{40}$/
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
function snapshot(
  capture: ReviewInputCapture,
  spec: PreparedReviewInputs['issueSpec'],
): PreparedReviewInputs['inputSnapshot'] {
  return {
    body: capture.body,
    spec: spec === null ? null : { reference: spec.reference, body: spec.body, lastEditedAt: spec.lastEditedAt },
  }
}
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

type ReviewMaterial = {
  refreshed: { ok: true; tip: string }
  stack: string | null
  baseStack: string | null
  chunks: PreparedReviewInputs['chunks']
}

async function reviewMaterial(
  options: PrepareReviewInputsOptions,
  git: Git,
  gh: (cwd: string, args: string[]) => Promise<string>,
  candidate: string,
  base: string,
  assetDir: string,
): Promise<Result<ReviewMaterial>> {
  const refreshed = await refreshReviewBase(options.cwd, base, git, gh)
  if (!refreshed.ok || !SHA.test(refreshed.tip)) {
    return failed<ReviewMaterial>(
      'base-unreadable',
      !refreshed.ok ? `${refreshed.reason}: ${refreshed.error}` : 'selected base did not resolve to a commit',
    )
  }
  const stack = await candidateText(git, options.cwd, candidate, '.dev/stack.yml', false)
  const baseStack = await candidateText(git, options.cwd, refreshed.tip, '.dev/stack.yml', false)
  const chunks = await materializeCandidateChunks({
    cwd: options.cwd,
    git,
    base: refreshed.tip,
    candidate,
    contextWindow: options.contextWindow,
    helper: join(assetDir, 'prepare_context.py'),
  })
  if (!chunks.length) {
    return failed<ReviewMaterial>('review-diff-empty', 'candidate has no diff against selected base')
  }
  return {
    ok: true,
    value: { refreshed, stack, baseStack, chunks },
  } satisfies Result<ReviewMaterial>
}

/** Read-only producer preparation: exact capture, raw candidate bytes, roster and prompts; no dispatch/write. */
export async function prepareReviewInputs(options: PrepareReviewInputsOptions): Promise<Result<PreparedReviewInputs>> {
  if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0) {
    return failed('invalid-context-window', 'review contextWindow must be a positive integer')
  }
  const gh = options.gh ?? defaultGh
  const git = options.git ?? defaultGit
  try {
    const target = await prepareReviewTarget(options.cwd, options.pr, gh, git)
    if (!target.ok) return target
    const { number, repository, automationLogin, candidate, pr, semanticContext, capture } = target.value
    const issueSpec = semanticContext.currentSpec
    const { tier, warnings } = tierDetails(issueSpec)
    const config = loadReviewConfig()
    const catalogue = loadReviewClassCatalogue()
    const { assetDir, canonicalClasses } = catalogue
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
    return {
      ok: true,
      value: {
        scope,
        context: {
          ...scope,
          number,
          candidateGitSHA: candidate,
          input: capture.input,
          subject: { kind: 'pull-request' },
        },
        pr: {
          number,
          head: candidate,
          base: pr.base,
          baseGitSHA: refreshed.tip,
          branch: pr.branch,
        },
        automationLogin,
        capture,
        observedEvidence: {
          reviewInput: capture.input,
          candidate: { head: candidate, base: refreshed.tip },
          pullRequest: capture.body,
          stack: { candidate: stack, base: baseStack },
          resolvedSpec:
            issueSpec === null
              ? null
              : {
                  reference: issueSpec.reference,
                  body: issueSpec.body,
                  lastEditedAt: issueSpec.lastEditedAt,
                },
          semanticContext,
        },
        inputSnapshot: snapshot(capture, issueSpec),
        issueSpec,
        semanticContext,
        tier,
        warnings: rosterConfig.warnings,
        chunks,
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
        rawOperatorRequest: {
          pullRequest: { number, body: pr.body },
          trackerIssue:
            issueSpec === null
              ? null
              : {
                  reference: issueSpec.reference,
                  body: issueSpec.body,
                  lastEditedAt: issueSpec.lastEditedAt,
                },
        },
      },
    }
  } catch (error) {
    return failed('review-input-preparation-failed', message(error))
  }
}
