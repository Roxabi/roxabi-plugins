import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GitHubOptions, githubScope, type Policy, specDigest } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/schemas.ts'
import {
  type AllocateReviewInput,
  normalizeTier,
  parsePricedFences,
  parseRosterConfig,
  parseStackPaths,
  specIsDraft,
} from '../skills/dev-review/roster'
import { type EpicRangeReviewRequest, epicBindReview, epicFinalReviewRequest } from '../skills/feature/epic-driver.ts'
import { proofSemanticContext, reviewSemanticCanon } from '../skills/feature/proof'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { PreparedReviewBatch, ReviewContext, ReviewPublisher } from './review.ts'
import { loadReviewConfig } from './review-config.ts'
import type { ReviewSemanticContext } from './review-context.ts'
import type { ObservedEvidence } from './review-inputs.ts'
import { buildReviewPrompts } from './review-prompts.ts'
import { CanonicalReviewRunner, type PreparedReviewInputs } from './review-runner.ts'
import { additionalRequirementsOf, type GitRunner } from './workflow-config.ts'

type AcceptedEpicSemantic = {
  semanticContext: ReviewSemanticContext
  semanticCanon: string
  /** Accepted Spec bytes used for issueSpec/display (exact resolveAcceptedSpec body). */
  spec: { reference: string; body: string; digest: string; lastEditedAt: string | null }
}

type LiveEpicSpec = {
  reference: string
  number: number
  body: string
  digest: string
  lastEditedAt: string | null
  labels: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function epicSemanticCanon(semanticContext: ReviewSemanticContext): string {
  const projected = proofSemanticContext(semanticContext)
  if ('ok' in projected) throw new Error(`${projected.reason}: ${projected.error}`)
  return reviewSemanticCanon(projected)
}

/**
 * Engine accepted Spec + effective requirements for the Epic mandate.
 * Uses EngineRecords resolveAcceptedSpec only — no payload.spec soft fallback.
 * Absent/incomplete mandate → null (caller keeps live-issue standalone).
 * Missing resolveAcceptedSpec API → throw (clean cutover, no permanent fallback).
 */
async function acceptedEpicSemantic(
  cwd: string,
  repository: string,
  epic: number,
  live: { reference: string; number: number; body: string; lastEditedAt: string | null; labels: readonly string[] },
  gh: Gh,
): Promise<AcceptedEpicSemantic | null> {
  const contracts = await import('../dist/contracts.js')
  if (
    typeof contracts.githubScope !== 'function' ||
    typeof contracts.specDigest !== 'function' ||
    typeof contracts.readComposedWorkflowHistory !== 'function' ||
    typeof contracts.selectApplicableMandate !== 'function' ||
    typeof contracts.resolveAcceptedSpec !== 'function'
  ) {
    return null
  }
  let composed: Awaited<ReturnType<typeof contracts.readComposedWorkflowHistory>>
  try {
    composed = await contracts.readComposedWorkflowHistory(
      [contracts.githubScope(repository, epic)],
      withRoxabiGitHubPolicy({ cwd, gh }),
    )
  } catch {
    return null
  }
  if (!composed.ok) return null
  const history = composed.histories[0]
  if (history === undefined) return null
  const parents = composed.histories.slice(1)
  const selected = contracts.selectApplicableMandate(history, parents)
  if (selected.status !== 'applicable') return null
  const mandate = selected.mandate
  const accepted = contracts.resolveAcceptedSpec(mandate, [history, ...parents])
  if (!accepted.ok) return null
  const config = isRecord(mandate.payload) && isRecord(mandate.payload.config) ? mandate.payload.config : null
  if (
    config === null ||
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string'
  ) {
    return null
  }
  const requirements = additionalRequirementsOf('effective' in config ? config.effective : null)
  const effectiveSerialized = JSON.stringify({
    productVersion: config.productVersion,
    version: config.version,
    digest: config.digest,
    additionalRequirements: requirements,
  })
  const scope = contracts.githubScope(repository, epic)
  const semanticContext: ReviewSemanticContext = {
    mode: 'bound',
    binding: { recordId: mandate.recordId, scope },
    acceptedSpec: {
      reference: accepted.spec.reference,
      body: accepted.spec.body,
      digest: accepted.spec.digest,
      lastEditedAt: accepted.spec.lastEditedAt,
      chain: accepted.spec.chain,
      sourceRefs: accepted.spec.sourceRefs,
    },
    currentSpec: {
      reference: live.reference,
      number: live.number,
      body: live.body,
      digest: contracts.specDigest(live.body),
      lastEditedAt: live.lastEditedAt,
      labels: live.labels,
    },
    effectiveConfig: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      serialized: effectiveSerialized,
    },
    additionalRequirements: requirements,
  }
  return {
    semanticContext,
    semanticCanon: epicSemanticCanon(semanticContext),
    spec: {
      reference: accepted.spec.reference,
      body: accepted.spec.body,
      digest: accepted.spec.digest,
      lastEditedAt: accepted.spec.lastEditedAt,
    },
  }
}

export type EpicFinalReviewRequest = EpicRangeReviewRequest

export type Gh = (cwd: string, args: string[]) => Promise<string>

type HelperChunk = {
  index: number
  delta: string[]
  diff: string
  files: { path: string; oldPath?: string; hunk?: string }[]
  digest: string
}

const SHA = /^[0-9a-f]{40}$/
const RANGE = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/

/** The driver emits its opaque canonical scope, never an operator shorthand. */
function epicNumberFromCanonicalTarget(repository: string, target: string): number {
  const separator = target.lastIndexOf('#')
  const numberText = separator > 0 ? target.slice(separator + 1) : ''
  if (!/^[1-9][0-9]*$/.test(numberText)) throw new Error('epic target unreadable')
  const epic = Number(numberText)
  if (!Number.isSafeInteger(epic)) throw new Error('epic target unreadable')
  if (target !== githubScope(repository, epic).target) throw new Error('epic target is outside its repository')
  return epic
}

async function gitText(git: GitRunner, cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
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
  const parsed: unknown = JSON.parse(stdout)
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('ok' in parsed) ||
    parsed.ok !== true ||
    !('chunks' in parsed) ||
    !Array.isArray(parsed.chunks)
  ) {
    throw new Error('prepare_context.py returned an invalid result')
  }
  return parsed.chunks as HelperChunk[]
}

async function fileText(
  git: GitRunner,
  cwd: string,
  commit: string,
  path: string,
  required: boolean,
): Promise<string | null> {
  const result = await git(cwd, ['show', `${commit}:${path}`])
  if (result.code !== 0) {
    if (required) throw new Error(`missing ${path} at ${commit}`)
    return null
  }
  return result.stdout
}

function deletions(nameStatus: string): Set<string> {
  const output = new Set<string>()
  const fields = nameStatus.split('\0').filter((entry) => entry.length > 0)
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++] ?? ''
    if (status[0] === 'R' || status[0] === 'C') {
      index += 2
      continue
    }
    const path = fields[index++]
    if (status[0] === 'D' && path) output.add(path)
  }
  return output
}

async function candidateBinary(
  git: GitRunner,
  cwd: string,
  base: string,
  candidate: string,
  path: string,
): Promise<boolean> {
  const result = await git(cwd, ['diff', '--numstat', base, candidate, '--', path])
  if (result.code !== 0) throw new Error(`candidate binary check failed for ${path}`)
  return result.stdout.startsWith('-\t-\t')
}

async function assembleEpicRangeInputs(input: {
  cwd: string
  request: EpicRangeReviewRequest
  git: GitRunner
  gh: Gh
  contextWindow?: number
  runId?: string
  operationId?: string
}): Promise<PreparedReviewInputs> {
  const matched = RANGE.exec(input.request.range)
  if (!matched) throw new Error('epic range must be an exact commit range')
  const base = matched[1] ?? ''
  const candidate = matched[2] ?? ''
  if (candidate !== input.request.candidateGitSHA) throw new Error('epic candidate must be the range tail')
  if (!SHA.test(base) || !SHA.test(candidate)) throw new Error('epic range has invalid commits')
  await gitText(input.git, input.cwd, ['rev-parse', '--verify', `${base}^{commit}`])
  await gitText(input.git, input.cwd, ['rev-parse', '--verify', `${candidate}^{commit}`])
  const epic = epicNumberFromCanonicalTarget(input.request.repository, input.request.target)
  const issueRaw = await input.gh(input.cwd, [
    'issue',
    'view',
    String(epic),
    '--repo',
    input.request.repository,
    '--json',
    'body,updatedAt,state,labels',
  ])
  const issueParsed: unknown = JSON.parse(issueRaw)
  if (
    issueParsed === null ||
    typeof issueParsed !== 'object' ||
    !('state' in issueParsed) ||
    (issueParsed.state !== 'OPEN' && issueParsed.state !== 'CLOSED') ||
    !('body' in issueParsed) ||
    typeof issueParsed.body !== 'string'
  ) {
    throw new Error('epic issue unreadable')
  }
  const labels = 'labels' in issueParsed && Array.isArray(issueParsed.labels) ? issueParsed.labels : []
  const sizes = labels.flatMap((label) =>
    label !== null &&
    typeof label === 'object' &&
    'name' in label &&
    typeof label.name === 'string' &&
    label.name.startsWith('size:')
      ? [label.name]
      : [],
  )
  const tier = normalizeTier(sizes[0]?.slice(5).trim() ?? '')
  const config = loadReviewConfig()
  const assetDir = join(config.chunker, '..')
  const classes = readFileSync(join(assetDir, 'review-classes.yml'), 'utf8')
  const evidencePolicy = readFileSync(join(assetDir, 'evidence-policy.md'), 'utf8')
  const rootCauses = readFileSync(join(assetDir, 'root-causes.md'), 'utf8')
  const smells = readFileSync(join(assetDir, 'review-smells.md'), 'utf8')
  const blindSpots = readFileSync(join(assetDir, 'review-blind-spots.md'), 'utf8')
  const classNames = [...classes.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (!classNames.length) throw new Error('installed class catalogue has no canonical classes')
  const stack = (await fileText(input.git, input.cwd, candidate, '.dev/stack.yml', false)) ?? ''
  const baseStack = (await fileText(input.git, input.cwd, base, '.dev/stack.yml', false)) ?? ''
  const rawDiff = await gitText(input.git, input.cwd, ['diff', '--no-ext-diff', '--binary', base, candidate])
  const helperChunks = await prepareChunks(
    input.cwd,
    join(config.chunker, '..', 'prepare_context.py'),
    rawDiff,
    input.contextWindow ?? 200_000,
  )
  if (!helperChunks.length) throw new Error('epic range has no diff')
  const deleted = deletions(await gitText(input.git, input.cwd, ['diff', '--name-status', '-z', base, candidate]))
  const chunks = await Promise.all(
    helperChunks.map(async (chunk) => ({
      index: chunk.index,
      delta: [...chunk.delta],
      diff: chunk.diff,
      digest: chunk.digest,
      files: await Promise.all(
        chunk.files.map(async (file) => {
          const removed = deleted.has(file.path)
          const binary = !removed && (await candidateBinary(input.git, input.cwd, base, candidate, file.path))
          return {
            path: file.path,
            oldPath: file.oldPath,
            hunk: file.hunk,
            deleted: removed,
            binary,
            text: removed || binary ? null : await fileText(input.git, input.cwd, candidate, file.path, true),
          }
        }),
      ),
    })),
  )
  const liveLabels = labels.flatMap((label) =>
    label !== null && typeof label === 'object' && 'name' in label && typeof label.name === 'string'
      ? [label.name]
      : [],
  )
  const liveIssueSpec = {
    reference: input.request.target,
    number: epic,
    body: issueParsed.body,
    lastEditedAt:
      'updatedAt' in issueParsed && typeof issueParsed.updatedAt === 'string' ? issueParsed.updatedAt : null,
    labels: liveLabels,
  }
  // Accepted Epic mandate Spec + requirements via EngineRecords; live body only if unbound.
  const accepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, liveIssueSpec, input.gh)
  const issueSpec =
    accepted === null
      ? liveIssueSpec
      : {
          reference: accepted.spec.reference,
          number: Number(/#(\d+)$/.exec(accepted.spec.reference)?.[1] ?? epic),
          body: accepted.spec.body,
          lastEditedAt: accepted.spec.lastEditedAt,
          labels: liveLabels,
        }
  const { specDigest } = (await import('../dist/contracts.js')) as { specDigest: (body: string) => string }
  const semanticContext: ReviewSemanticContext = accepted?.semanticContext ?? {
    mode: 'standalone',
    binding: null,
    acceptedSpec: null,
    currentSpec: {
      reference: issueSpec.reference,
      number: issueSpec.number,
      body: issueSpec.body,
      digest: specDigest(issueSpec.body),
      lastEditedAt: issueSpec.lastEditedAt,
      labels: issueSpec.labels,
    },
    effectiveConfig: null,
    additionalRequirements: [],
  }
  const semanticCanon = accepted?.semanticCanon ?? epicSemanticCanon(semanticContext)
  const parsedSpec = parsePricedFences(issueSpec.body)
  if (!parsedSpec.pricedClaimOk) throw new Error('epic issue has a priced fence without a valid claim')
  const rosterConfig = parseRosterConfig(stack)
  const roster: AllocateReviewInput['shared'] = {
    delta: chunks.flatMap((chunk) => chunk.delta),
    tier,
    chunks: chunks.length,
    claims: parsedSpec.claims,
    pricedClaimOk: parsedSpec.pricedClaimOk,
    specDraft: specIsDraft(issueSpec.body),
    axialAdr: false,
    stackPaths: parseStackPaths(stack),
    config: rosterConfig,
  }
  const policy: Policy = { version: 'baseline' }
  const assets = { evidencePolicy, rootCauses, classes, smells, blindSpots }
  const spec = { source: 'tracker-issue' as const, issue: issueSpec.number, body: issueSpec.body, rows: [] }
  const prompts = buildReviewPrompts({ tier, policy, spec, semanticContext, semanticCanon, assets })
  const observedEvidence: ObservedEvidence = {
    reviewInput: null,
    candidate: { head: candidate, base },
    pullRequest: null,
    stack: { candidate: stack, base: baseStack },
    resolvedSpec: {
      reference: issueSpec.reference,
      body: issueSpec.body,
      lastEditedAt: issueSpec.lastEditedAt,
    },
    semanticContext,
    semctx: null,
    assertledger: null,
  }
  const scope = { repository: input.request.repository, target: input.request.target }
  const runId = input.runId ?? input.request.runId
  const operationId = input.operationId ?? `epic-range-${randomUUID()}`
  return {
    context: {
      ...scope,
      number: epic,
      candidateGitSHA: candidate,
      input: null,
      subject: { kind: 'epic-range', range: input.request.range },
      runId,
      operationId,
    },
    pr: { base: 'epic-range', baseGitSHA: base },
    chunks,
    roster,
    config: { ...config, canonicalClasses: classNames },
    policy,
    semantic: { spec: prompts.spec, panel: prompts.panel, synthesis: prompts.synthesis },
    observedEvidence,
    inputSnapshot: {
      body: null,
      spec: { reference: issueSpec.reference, body: issueSpec.body, lastEditedAt: issueSpec.lastEditedAt },
      semctxParts: null,
      assertledgerParts: null,
    },
    canonicalClasses: classNames,
    authorize: async () => ({ ok: true }),
  }
}

function githubOptions(cwd: string, gh: Gh): GitHubOptions {
  return withRoxabiGitHubPolicy({ cwd, gh })
}

/**
 * Host-only handoff for the one canonical runner that assembled the final
 * Epic review. It never crosses the native task boundary.
 */
export type PreparedEpicReview = {
  context: ReviewContext & { readonly number: number }
  prepared: PreparedReviewBatch
  publisher: ReviewPublisher
}

/** Builds one Epic final-review runner and its native continuation materials. */
export async function prepareEpicFinalReviewMaterials(input: {
  cwd: string
  request: EpicRangeReviewRequest
  mandateRef: ScopedRecordRef
  git: GitRunner
  gh: Gh
}): Promise<PreparedEpicReview> {
  const assembled = await assembleEpicRangeInputs(input)
  const context = assembled.context
  const epic = context.number
  const sameMandate = (semantic: ReviewSemanticContext): boolean =>
    semantic.binding !== null &&
    semantic.binding.recordId === input.mandateRef.recordId &&
    semantic.binding.scope.repository === input.mandateRef.scope.repository &&
    semantic.binding.scope.target === input.mandateRef.scope.target
  const readLiveSpec = async (): Promise<LiveEpicSpec> => {
    const issue = JSON.parse(
      await input.gh(input.cwd, [
        'issue',
        'view',
        String(epic),
        '--repo',
        input.request.repository,
        '--json',
        'body,updatedAt,labels',
      ]),
    ) as unknown
    if (!isRecord(issue) || typeof issue.body !== 'string') throw new Error('epic-live-spec-unreadable')
    const labels = Array.isArray(issue.labels)
      ? issue.labels.flatMap((label) => (isRecord(label) && typeof label.name === 'string' ? [label.name] : []))
      : []
    return {
      reference: input.request.target,
      number: epic,
      body: issue.body,
      digest: specDigest(issue.body),
      lastEditedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
      labels,
    }
  }
  const specMatches = (accepted: AcceptedEpicSemantic['spec'], live: LiveEpicSpec): boolean =>
    accepted.reference === live.reference && accepted.body === live.body && accepted.digest === live.digest
  const capturedSemantic = assembled.observedEvidence.semanticContext
  if (
    capturedSemantic === undefined ||
    capturedSemantic.mode !== 'bound' ||
    !sameMandate(capturedSemantic) ||
    capturedSemantic.acceptedSpec.reference !== capturedSemantic.currentSpec.reference ||
    capturedSemantic.acceptedSpec.body !== capturedSemantic.currentSpec.body ||
    capturedSemantic.acceptedSpec.digest !== capturedSemantic.currentSpec.digest
  ) {
    throw new Error('epic-bound-semantic-mismatch')
  }
  const originalLive = await readLiveSpec()
  const originalAccepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, originalLive, input.gh)
  if (
    originalAccepted === null ||
    originalAccepted.semanticContext.mode !== 'bound' ||
    !sameMandate(originalAccepted.semanticContext) ||
    !specMatches(originalAccepted.spec, originalLive) ||
    originalAccepted.semanticCanon !== epicSemanticCanon(capturedSemantic)
  ) {
    throw new Error('epic-bound-semantic-mismatch')
  }
  const validate = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      const current = await epicFinalReviewRequest(input.cwd, epic)
      if (
        current.repository !== input.request.repository ||
        current.target !== input.request.target ||
        current.runId !== input.request.runId ||
        current.range !== input.request.range ||
        current.candidateGitSHA !== input.request.candidateGitSHA
      ) {
        return { ok: false, reason: 'epic-range-context-mismatch' }
      }
      const live = await readLiveSpec()
      const accepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, live, input.gh)
      if (
        accepted === null ||
        capturedSemantic.mode !== 'bound' ||
        accepted.semanticContext.mode !== 'bound' ||
        !sameMandate(accepted.semanticContext) ||
        !specMatches(accepted.spec, live) ||
        accepted.semanticCanon !== epicSemanticCanon(capturedSemantic)
      ) {
        return { ok: false, reason: 'epic-bound-semantic-unreadable' }
      }
      const capturedLive = capturedSemantic.currentSpec
      if (
        live.reference !== capturedLive.reference ||
        live.body !== capturedLive.body ||
        live.digest !== capturedLive.digest
      ) {
        return { ok: false, reason: 'epic-live-spec-mismatch' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
  assembled.authorize = async () => validate()
  const runner = new CanonicalReviewRunner(assembled, githubOptions(input.cwd, input.gh))
  const prepared = runner.initialBatch()
  let bound = false
  const publisher: ReviewPublisher = {
    authorize: (reviewContext, stage) => runner.authorize(reviewContext, stage),
    publishInventory: (batch) => runner.publishInventory(batch),
    publishRawContribution: (batch, child) => runner.publishRawContribution(batch, child),
    async completeStage(batch, result, contributions) {
      const next = await runner.completeStage(batch, result, contributions)
      if (next !== null) return next
      const decisionId = runner.confirmedDecisionId()
      if (decisionId === null) throw new Error('epic-review-decision-unconfirmed')
      if (!bound) {
        bound = true
        await epicBindReview(input.cwd, epic, decisionId, input.request.range)
      }
      return null
    },
    publishRequiredStop: () => runner.publishRequiredStop(),
    stop: (reviewContext, reason) => runner.stop(reviewContext, reason),
  }
  return { context, prepared, publisher }
}
