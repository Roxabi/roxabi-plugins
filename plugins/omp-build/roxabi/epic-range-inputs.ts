import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { githubScope, type Policy, specDigest } from '../dist/contracts.js'
import { parseRosterConfig, parseStackPaths } from '../skills/dev-review/roster-config'
import type { AllocateReviewInput } from '../skills/dev-review/roster-contract'
import { normalizeTier, parsePricedFences, specIsDraft } from '../skills/dev-review/roster-spec'
import type { EpicRangeReviewRequest } from '../skills/feature/epic-driver'
import { acceptedEpicSemantic, epicSemanticCanon } from './epic-range-semantic'
import { candidateText, materializeCandidateChunks } from './review-candidate-material'
import { loadReviewConfig } from './review-config'
import type { Gh, Git, ObservedEvidence } from './review-input-contract'
import { buildReviewPrompts } from './review-prompts'
import type { PreparedReviewInputs } from './review-runner'

const SHA = /^[0-9a-f]{40}$/
const RANGE = /^([0-9a-f]{40})\.\.([0-9a-f]{40})$/
function epicNumber(repository: string, target: string): number {
  const separator = target.lastIndexOf('#')
  const numberText = separator > 0 ? target.slice(separator + 1) : ''
  if (!/^[1-9][0-9]*$/.test(numberText)) throw new Error('epic target unreadable')
  const number = Number(numberText)
  if (!Number.isSafeInteger(number) || githubScope(repository, number).target !== target) {
    throw new Error('epic target unreadable')
  }
  return number
}

function exactRange(request: EpicRangeReviewRequest): { base: string; candidate: string } {
  const range = RANGE.exec(request.range)
  if (!range || range[2] !== request.candidateGitSHA || !SHA.test(range[1]) || !SHA.test(range[2])) {
    throw new Error('epic range must be an exact candidate commit range')
  }
  return { base: range[1], candidate: range[2] }
}

async function gitText(git: Git, cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args)
  if (result.code !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

async function verifyRangeCommits(git: Git, cwd: string, base: string, candidate: string): Promise<void> {
  await Promise.all([
    gitText(git, cwd, ['rev-parse', '--verify', `${base}^{commit}`]),
    gitText(git, cwd, ['rev-parse', '--verify', `${candidate}^{commit}`]),
  ])
}

async function readEpicIssue(
  cwd: string,
  repository: string,
  epic: number,
  gh: Gh,
): Promise<{ body: string; updatedAt: string | null; labels: string[] }> {
  const issue = JSON.parse(
    await gh(cwd, ['issue', 'view', String(epic), '--repo', repository, '--json', 'body,updatedAt,state,labels']),
  ) as { state?: unknown; body?: unknown; updatedAt?: unknown; labels?: unknown }
  if (
    (issue.state !== 'OPEN' && issue.state !== 'CLOSED') ||
    typeof issue.body !== 'string' ||
    !Array.isArray(issue.labels)
  ) {
    throw new Error('epic issue unreadable')
  }
  return {
    body: issue.body,
    updatedAt: typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
    labels: issue.labels.flatMap((label) =>
      typeof label === 'object' && label !== null && 'name' in label && typeof label.name === 'string'
        ? [label.name]
        : [],
    ),
  }
}

function reviewAssets() {
  const config = loadReviewConfig()
  const assetDir = join(config.chunker, '..')
  const classes = readFileSync(join(assetDir, 'review-classes.yml'), 'utf8')
  const classNames = [...classes.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (!classNames.length) throw new Error('installed class catalogue has no canonical classes')
  return { config, assetDir, classes, classNames }
}

function promptAssets(assetDir: string, classes: string) {
  return {
    classes,
    evidencePolicy: readFileSync(join(assetDir, 'evidence-policy.md'), 'utf8'),
    rootCauses: readFileSync(join(assetDir, 'root-causes.md'), 'utf8'),
    smells: readFileSync(join(assetDir, 'review-smells.md'), 'utf8'),
    blindSpots: readFileSync(join(assetDir, 'review-blind-spots.md'), 'utf8'),
  }
}

async function resolveEpicSemantic(
  cwd: string,
  repository: string,
  epic: number,
  target: string,
  issue: { body: string; updatedAt: string | null; labels: string[] },
  gh: Gh,
) {
  const live = {
    reference: target,
    number: epic,
    body: issue.body,
    digest: specDigest(issue.body),
    lastEditedAt: issue.updatedAt,
    labels: issue.labels,
  }
  const accepted = await acceptedEpicSemantic(cwd, repository, epic, live, gh)
  const issueSpec =
    accepted === null
      ? live
      : {
          reference: accepted.spec.reference,
          number: Number(/#(\d+)$/.exec(accepted.spec.reference)?.[1] ?? epic),
          body: accepted.spec.body,
          digest: accepted.spec.digest,
          lastEditedAt: accepted.spec.lastEditedAt,
          labels: issue.labels,
        }
  const semanticContext = accepted?.semanticContext ?? {
    mode: 'standalone' as const,
    binding: null,
    acceptedSpec: null,
    currentSpec: issueSpec,
    effectiveConfig: null,
    additionalRequirements: [],
  }
  return {
    issueSpec,
    semanticContext,
    semanticCanon: accepted?.semanticCanon ?? epicSemanticCanon(semanticContext),
  }
}

/** Exact Epic range facts/material and mandate-aware semantic projection. */
export async function assembleEpicRangeInputs(input: {
  cwd: string
  request: EpicRangeReviewRequest
  contextWindow?: number
  runId?: string
  operationId?: string
  gh: Gh
  git: Git
}): Promise<PreparedReviewInputs> {
  const { base, candidate } = exactRange(input.request)
  await verifyRangeCommits(input.git, input.cwd, base, candidate)
  const epic = epicNumber(input.request.repository, input.request.target)
  const issue = await readEpicIssue(input.cwd, input.request.repository, epic, input.gh)
  const { config, assetDir, classes, classNames } = reviewAssets()
  const [stack, baseStack] = await Promise.all([
    candidateText(input.git, input.cwd, candidate, '.dev/stack.yml', false),
    candidateText(input.git, input.cwd, base, '.dev/stack.yml', false),
  ])
  const chunks = await materializeCandidateChunks({
    cwd: input.cwd,
    git: input.git,
    base,
    candidate,
    contextWindow: input.contextWindow ?? 200_000,
    helper: join(assetDir, 'prepare_context.py'),
  })
  if (!chunks.length) throw new Error('epic range has no diff')
  const { issueSpec, semanticContext, semanticCanon } = await resolveEpicSemantic(
    input.cwd,
    input.request.repository,
    epic,
    input.request.target,
    issue,
    input.gh,
  )
  const parsed = parsePricedFences(issueSpec.body)
  if (!parsed.pricedClaimOk) throw new Error('epic issue has a priced fence without a valid claim')
  const roster: AllocateReviewInput['shared'] = {
    delta: chunks.flatMap((chunk) => chunk.delta),
    tier: normalizeTier(
      issue.labels
        .find((label) => label.startsWith('size:'))
        ?.slice(5)
        .trim() ?? '',
    ),
    chunks: chunks.length,
    claims: parsed.claims,
    pricedClaimOk: parsed.pricedClaimOk,
    specDraft: specIsDraft(issueSpec.body),
    axialAdr: false,
    stackPaths: parseStackPaths(stack),
    config: parseRosterConfig(stack),
  }
  const policy: Policy = { version: 'baseline' }
  const assets = promptAssets(assetDir, classes)
  const spec = { source: 'tracker-issue' as const, issue: issueSpec.number, body: issueSpec.body, rows: [] }
  const prompts = buildReviewPrompts({ tier: roster.tier, policy, spec, semanticContext, semanticCanon, assets })
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
  return {
    context: {
      ...scope,
      number: epic,
      candidateGitSHA: candidate,
      input: null,
      subject: { kind: 'epic-range', range: input.request.range },
      runId: input.runId ?? input.request.runId,
      operationId: input.operationId ?? `epic-range-${randomUUID()}`,
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
      spec: {
        reference: issueSpec.reference,
        body: issueSpec.body,
        lastEditedAt: issueSpec.lastEditedAt,
      },
      semctxParts: null,
      assertledgerParts: null,
    },
    canonicalClasses: classNames,
    authorize: async () => ({ ok: true }),
  }
}
