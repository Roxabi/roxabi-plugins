import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { Json, Policy, Result, ReviewInputSnapshot, Scope } from '../dist/contracts.js'
import {
  type AllocateReviewInput,
  normalizeTier,
  parsePricedFences,
  parseRosterConfig,
  parseStackPaths,
  type ReviewTier,
  specIsDraft,
} from '../skills/dev-review/roster'
import {
  type Git,
  type GitResult,
  type ProofSemanticContext,
  proofSemanticContext,
  refreshSelectedBase,
} from '../skills/feature/proof'
import { captureReviewInput, resolveReviewPr } from '../skills/feature/workflow.js'
import { loadReviewConfig, type ReviewConfig } from './review-config'
import { type ReviewIssueSpec, type ReviewSemanticContext, resolveReviewSemanticContext } from './review-context'
import { buildReviewPrompts, type ReviewPrompts, type ReviewSemanticAssets, type SpecDisplay } from './review-prompts'

export type Gh = (cwd: string, args: string[]) => Promise<string>
export type SelectedProofPart = {
  id?: number
  author: { login: string }
  body: string
  createdAt?: string
  updatedAt?: string
}
export type SelectedProof = { record: unknown; parts: readonly SelectedProofPart[] }
export type ReviewInputCapture = {
  ok: true
  input: string | null
  body: { body: string; lastEditedAt: string | null } | null
  semctx: SelectedProof | null
  assertledger: SelectedProof | null
  /** Exact semantic projection and canon supplied to capture and input hashing. */
  semantic: ProofSemanticContext
  semanticCanon: string
}

/** Read-only facts captured once for model context; neither a record nor a hash input is rebuilt here. */
export type ObservedEvidence = {
  reviewInput: string | null
  candidate: { head: string; base: string }
  pullRequest: ReviewInputCapture['body']
  stack: { candidate: string | null; base: string | null }
  resolvedSpec: { reference: string; body: string; lastEditedAt: string | null } | null
  /** PR review assembly includes the binding-aware context; Epic range evidence has its own semantic source. */
  semanticContext?: ReviewSemanticContext
  semctx: SelectedProof | null
  assertledger: SelectedProof | null
}
export type ReviewFile = {
  path: string
  oldPath?: string
  hunk?: string
  text: string | null
  deleted: boolean
  binary: boolean
}
export type PreparedReviewChunk = { index: number; delta: string[]; diff: string; files: ReviewFile[]; digest: string }
export type IssueSpec = ReviewIssueSpec
export type PreparedReviewInputs = {
  scope: Scope
  context: Scope & { number: number; candidateGitSHA: string; input: string | null; subject: { kind: 'pull-request' } }
  pr: { number: number; head: string; base: string; baseGitSHA: string; branch: string }
  automationLogin: string
  capture: ReviewInputCapture
  observedEvidence: ObservedEvidence
  inputSnapshot: ReviewInputSnapshot
  issueSpec: IssueSpec | null
  semanticContext: ReviewSemanticContext
  tier: ReviewTier
  warnings: string[]
  chunks: PreparedReviewChunk[]
  roster: AllocateReviewInput['shared']
  config: ReviewConfig
  policy: Policy
  semantic: { assets: ReviewSemanticAssets; spec: SpecDisplay; prompts: ReviewPrompts }
  rawOperatorRequest: Json
}
export type PrepareReviewInputsOptions = {
  cwd: string
  pr?: number | string
  contextWindow: number
  gh?: Gh
  git?: Git
}

type PrDetails = { headRefOid: string; baseRefName: string; headRefName: string; body: string; state: string }
type HelperChunk = {
  index: number
  delta: string[]
  diff: string
  files: { path: string; oldPath?: string; hunk?: string }[]
  digest: string
}

const execFileAsync = promisify(execFile)
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

function failed<T>(code: string, message: string): Result<T> {
  return { ok: false, diagnostics: [{ code, message }] }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`${source} returned invalid JSON`)
  }
}
function expectPr(value: unknown): PrDetails {
  if (
    !isObject(value) ||
    typeof value.headRefOid !== 'string' ||
    typeof value.baseRefName !== 'string' ||
    typeof value.headRefName !== 'string' ||
    typeof value.body !== 'string' ||
    typeof value.state !== 'string'
  )
    throw new Error('gh pr view returned incomplete PR facts')
  return value as PrDetails
}
function expectRepository(value: unknown): string {
  if (!isObject(value) || typeof value.nameWithOwner !== 'string' || !value.nameWithOwner.includes('/'))
    throw new Error('gh repo view returned no repository identity')
  return value.nameWithOwner
}
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
async function requireGit(git: Git, cwd: string, args: string[], label: string): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) throw new Error(`${label}: ${result.stderr || result.stdout || 'git command failed'}`)
  return result.stdout
}
async function candidateText(
  git: Git,
  cwd: string,
  sha: string,
  path: string,
  required: boolean,
): Promise<string | null> {
  const result = await git(cwd, ['show', [sha, path].join(':')])
  if (result.code === 0) return result.stdout
  if (!required) return null
  throw new Error(`candidate blob is unreadable: ${path}: ${result.stderr || result.stdout}`)
}
async function candidateHasAxialAdr(git: Git, cwd: string, candidate: string): Promise<boolean> {
  const paths = await requireGit(
    git,
    cwd,
    ['ls-tree', '-r', '--name-only', candidate, '--', 'docs/architecture/adr'],
    'candidate axial ADR discovery',
  )
  for (const path of paths.split('\n')) {
    if (!path.endsWith('.md')) continue
    const text = await candidateText(git, cwd, candidate, path, true)
    if (/^axial:\s*true/m.test(text ?? '')) return true
  }
  return false
}
function deletions(raw: string): Set<string> {
  const output = new Set<string>()
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]
    if (!status) continue
    if (status[0] === 'R' || status[0] === 'C') {
      index += 2
      continue
    }
    const path = fields[index++]
    if (status[0] === 'D' && path) output.add(path)
  }
  return output
}
async function candidateBinary(git: Git, cwd: string, base: string, candidate: string, path: string): Promise<boolean> {
  const result = await git(cwd, ['diff', '--numstat', base, candidate, '--', path])
  if (result.code !== 0) throw new Error(`candidate binary check failed for ${path}`)
  return result.stdout.startsWith('-\t-\t')
}
async function prepareChunks(
  cwd: string,
  helper: string,
  rawDiff: string,
  contextWindow: number,
): Promise<HelperChunk[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      'python3',
      [helper],
      { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (error, value, stderr) => {
        if (error) {
          reject(new Error(`prepare_context.py failed: ${String(stderr) || error.message}`))
          return
        }
        resolve(String(value))
      },
    )
    child.stdin?.end(JSON.stringify({ rawDiff, contextWindow }))
  })
  const result = parseJson(stdout, 'prepare_context.py')
  if (!isObject(result) || result.ok !== true || !Array.isArray(result.chunks))
    throw new Error('prepare_context.py returned an invalid result')
  return result.chunks as HelperChunk[]
}
function snapshot(capture: ReviewInputCapture, spec: IssueSpec | null): ReviewInputSnapshot {
  const parts = (selected: SelectedProof | null) =>
    selected === null
      ? null
      : selected.parts.map((part) => {
          if (!Number.isInteger(part.id) || (part.id ?? 0) < 1)
            throw new Error('selected proof part lacks a native identity')
          return { id: part.id as number, createdAt: part.createdAt ?? null, updatedAt: part.updatedAt ?? null }
        })
  return {
    body: capture.body,
    spec: spec === null ? null : { reference: spec.reference, body: spec.body, lastEditedAt: spec.lastEditedAt },
    semctxParts: parts(capture.semctx),
    assertledgerParts: parts(capture.assertledger),
  }
}

function observedEvidence(
  capture: ReviewInputCapture,
  spec: IssueSpec | null,
  semanticContext: ReviewSemanticContext,
  candidate: string,
  base: string,
  stack: { candidate: string | null; base: string | null },
): ObservedEvidence {
  return {
    reviewInput: capture.input,
    candidate: { head: candidate, base },
    pullRequest: capture.body,
    stack,
    resolvedSpec:
      spec === null ? null : { reference: spec.reference, body: spec.body, lastEditedAt: spec.lastEditedAt },
    semanticContext,
    semctx: capture.semctx,
    assertledger: capture.assertledger,
  }
}

/** Read-only producer preparation: it neither dispatches native tasks nor writes GitHub records. */
export async function prepareReviewInputs(options: PrepareReviewInputsOptions): Promise<Result<PreparedReviewInputs>> {
  if (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0)
    return failed('invalid-context-window', 'review contextWindow must be a positive integer')
  const gh = options.gh ?? defaultGh
  const git = options.git ?? defaultGit
  try {
    const number = await resolveReviewPr(options.cwd, options.pr, { gh, git })
    if (number === null) return failed('review-target-absent', 'no pull request is bound to this review')
    const pr = expectPr(
      parseJson(
        await gh(options.cwd, [
          'pr',
          'view',
          String(number),
          '--json',
          'headRefOid,baseRefName,headRefName,body,state',
        ]),
        'gh pr view',
      ),
    )
    if (pr.state !== 'OPEN') return failed('review-target-closed', `PR #${number} is ${pr.state}`)
    if (!SHA.test(pr.headRefOid) || !pr.baseRefName || !pr.headRefName)
      return failed('review-target-unreadable', 'PR did not provide complete head/base/branch facts')
    const candidate = (
      await requireGit(
        git,
        options.cwd,
        ['rev-parse', '--verify', `${pr.headRefOid}^{commit}`],
        'candidate verification',
      )
    ).trim()
    if (candidate !== pr.headRefOid) return failed('candidate-unbound', 'local candidate does not match the PR head')
    const repository = expectRepository(
      parseJson(await gh(options.cwd, ['repo', 'view', '--json', 'nameWithOwner']), 'gh repo view'),
    )
    const automationLogin = (await gh(options.cwd, ['api', 'user', '--jq', '.login'])).trim()
    if (!automationLogin) return failed('automation-login-unreadable', 'gh api user returned no login')
    const semanticResult = await resolveReviewSemanticContext({
      cwd: options.cwd,
      repository,
      pr: number,
      body: pr.body,
      branch: pr.headRefName,
      base: pr.baseRefName,
      automationLogin,
      gh,
    })
    if (!semanticResult.ok) {
      const detail = semanticResult.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join('; ')
      return failed('review-semantic-context-refused', detail)
    }
    const semanticContext = semanticResult.value
    const proofSemantic = proofSemanticContext(semanticContext)
    if ('ok' in proofSemantic)
      return failed('review-semantic-context-refused', `${proofSemantic.reason}: ${proofSemantic.error}`)
    const capture = await captureReviewInput(options.cwd, number, candidate, { gh, git, semantic: proofSemantic })
    if (!capture.ok) return failed('review-input-refused', `${capture.producer}:${capture.reason}: ${capture.error}`)
    const semanticCanon = capture.semanticCanon

    const warnings: string[] = []
    const issueSpec: IssueSpec | null = semanticContext.currentSpec
    let tier = normalizeTier('')
    if (issueSpec === null) warnings.push('no tracker issue reference — review tier defaults to F-lite')
    else {
      const sizes = issueSpec.labels.filter((label) => label.startsWith('size:'))
      const rawSize = sizes[0]?.slice(5).trim() ?? ''
      tier = normalizeTier(rawSize)
      if (!rawSize) warnings.push(`no size: label on #${issueSpec.number} — review tier defaults to F-lite`)
      else if (!Object.hasOwn(SIZE_VALUES, rawSize.toLowerCase()))
        warnings.push(
          `size: label ${JSON.stringify(rawSize)} on #${issueSpec.number} is not canonical — review tier defaults to F-lite`,
        )
      if (sizes.length > 1)
        warnings.push(`tracker issue #${issueSpec.number} has multiple size labels; using ${sizes[0]}`)
    }

    const config = loadReviewConfig()
    const assetDir = join(config.chunker, '..')
    const classes = readFileSync(join(assetDir, 'review-classes.yml'), 'utf8')
    const evidencePolicy = readFileSync(join(assetDir, 'evidence-policy.md'), 'utf8')
    const rootCauses = readFileSync(join(assetDir, 'root-causes.md'), 'utf8')
    const smells = readFileSync(join(assetDir, 'review-smells.md'), 'utf8')
    const blindSpots = readFileSync(join(assetDir, 'review-blind-spots.md'), 'utf8')
    const stack = await candidateText(git, options.cwd, candidate, '.dev/stack.yml', false)
    const classNames = [...classes.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
    if (!classNames.length)
      return failed('review-class-catalogue-invalid', 'installed class catalogue has no canonical classes')
    const candidateConfig: ReviewConfig = { ...config, canonicalClasses: classNames }
    const refreshedBase = await refreshSelectedBase(options.cwd, pr.baseRefName, git, gh)
    if (!refreshedBase.ok) return failed('base-unreadable', `${refreshedBase.reason}: ${refreshedBase.error}`)
    const base = refreshedBase.tip
    if (!SHA.test(base)) return failed('base-unreadable', 'selected base did not resolve to a commit')
    const baseStack = await candidateText(git, options.cwd, base, '.dev/stack.yml', false)
    const rawDiff = await requireGit(
      git,
      options.cwd,
      ['diff', '--no-ext-diff', '--binary', base, candidate],
      'candidate diff',
    )
    const helperChunks = await prepareChunks(
      options.cwd,
      join(config.chunker, '..', 'prepare_context.py'),
      rawDiff,
      options.contextWindow,
    )
    if (!helperChunks.length) return failed('review-diff-empty', 'candidate has no diff against selected base')
    const deleted = deletions(
      await requireGit(git, options.cwd, ['diff', '--name-status', '-z', base, candidate], 'candidate status'),
    )
    const chunks = await Promise.all(
      helperChunks.map(async (chunk) => ({
        index: chunk.index,
        delta: [...chunk.delta],
        diff: chunk.diff,
        digest: chunk.digest,
        files: await Promise.all(
          chunk.files.map(async (file) => {
            const removed = deleted.has(file.path)
            const binary = !removed && (await candidateBinary(git, options.cwd, base, candidate, file.path))
            return {
              path: file.path,
              oldPath: file.oldPath,
              hunk: file.hunk,
              deleted: removed,
              binary,
              text: removed || binary ? null : await candidateText(git, options.cwd, candidate, file.path, true),
            }
          }),
        ),
      })),
    )
    const parsedSpec = issueSpec === null ? { claims: [], pricedClaimOk: true } : parsePricedFences(issueSpec.body)
    if (!parsedSpec.pricedClaimOk)
      return failed('priced-fence-invalid', 'tracker issue has a priced fence without a valid claim')
    const rosterConfig = parseRosterConfig(stack)
    rosterConfig.warnings.push(...warnings)
    const roster: AllocateReviewInput['shared'] = {
      delta: chunks.flatMap((chunk) => chunk.delta),
      tier,
      chunks: chunks.length,
      claims: parsedSpec.claims,
      pricedClaimOk: parsedSpec.pricedClaimOk,
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
    const assets = { evidencePolicy, rootCauses, classes, smells, blindSpots }
    const observed = observedEvidence(capture, issueSpec, semanticContext, candidate, base, {
      candidate: stack,
      base: baseStack,
    })
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
        pr: { number, head: candidate, base: pr.baseRefName, baseGitSHA: base, branch: pr.headRefName },
        automationLogin,
        capture,
        observedEvidence: observed,
        inputSnapshot: snapshot(capture, issueSpec),
        issueSpec,
        semanticContext,
        tier,
        warnings: rosterConfig.warnings,
        chunks,
        roster,
        config: candidateConfig,
        policy,
        semantic: {
          assets,
          spec,
          prompts: buildReviewPrompts({ tier, policy, spec, semanticContext, semanticCanon, assets }),
        },
        rawOperatorRequest: {
          pullRequest: { number, body: pr.body },
          trackerIssue:
            issueSpec === null
              ? null
              : { reference: issueSpec.reference, body: issueSpec.body, lastEditedAt: issueSpec.lastEditedAt },
        },
      },
    }
  } catch (error) {
    return failed('review-input-preparation-failed', message(error))
  }
}
