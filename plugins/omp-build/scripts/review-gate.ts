#!/usr/bin/env bun

import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  decodeHistory,
  deriveReviewState,
  githubScope,
  type Json,
  type Result,
  readGitHubHistory,
  summarizeReviews,
} from '../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { type Admission, admitLanding, type Gh, type Git, refreshSelectedBase } from '../skills/feature/proof.ts'
import { currentLandingMandate, type LandingMandateDecision } from '../skills/feature/workflow.js'

type Arguments = {
  repository: string
  pr: number
  head: string
  automationLogin: string
  candidateCwd: string
  toolingSha: string
}

type CommandResult = { code: number; stdout: string; stderr: string }

type MachineResult =
  | { ok: true; allowed: true; reviews: number; ci: 'green' | 'red' | 'pending' | 'unknown' }
  | { ok: false; allowed: false; reason: string; detail?: Json }

const SHA = /^[0-9a-f]{40}$/
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:_[A-Za-z0-9]+)?(?:\[bot\])?$/
const CI_WATCH = 'plugins/omp-build/skills/ci-watch/ci-watch.sh'
const TAXONOMY = 'plugins/omp-build/skills/dev-review/review-classes.yml'

function output(result: MachineResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function fail(reason: string, detail?: Json): never {
  output(detail === undefined ? { ok: false, allowed: false, reason } : { ok: false, allowed: false, reason, detail })
  process.exitCode = 1
  throw new Error(reason)
}
function jsonDetail(value: unknown): Json {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as Json
}

function usage(): never {
  return fail('usage', { expected: '--repository --pr --head --automation-login --candidate-cwd --tooling-sha' })
}

function parse(argv: string[]): Arguments {
  const values: Record<string, string | undefined> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || values[flag] !== undefined) usage()
    values[flag] = value
  }
  const repository = values['--repository'] ?? ''
  const prText = values['--pr'] ?? ''
  const head = values['--head'] ?? ''
  const automationLogin = values['--automation-login'] ?? ''
  const candidateCwd = values['--candidate-cwd'] ?? ''
  const toolingSha = values['--tooling-sha'] ?? ''
  const pr = Number(prText)
  if (
    !REPOSITORY.test(repository) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !SHA.test(head) ||
    !LOGIN.test(automationLogin)
  )
    usage()
  if (!isAbsolute(candidateCwd) || !SHA.test(toolingSha)) usage()
  return { repository, pr, head, automationLogin, candidateCwd, toolingSha }
}

function trustedEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env }
  for (const name of [
    'BUN_OPTIONS',
    'BUN_PRELOAD',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_INDEX_FILE',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
  ]) {
    delete environment[name]
  }
  environment.GIT_CONFIG_GLOBAL = '/dev/null'
  environment.GIT_CONFIG_NOSYSTEM = '1'
  return environment
}

/**
 * Process-local Git credential binding for verified fetches under
 * `persist-credentials: false`. Prefer an existing GIT_CONFIG_* helper already
 * on the process; otherwise bind `gh auth git-credential` when GH_TOKEN /
 * GITHUB_TOKEN is present. No token URLs, argv secrets, global gitconfig, or
 * extra workflow Permissions. Private hosted fetch capability remains T5-
 * unproved, but real CI must not be left unable to fetch a private repo.
 */
function gitFetchEnvironment(): Record<string, string | undefined> {
  const environment = trustedEnvironment()
  if (environment.GIT_CONFIG_COUNT !== undefined && environment.GIT_CONFIG_COUNT !== '') {
    return environment
  }
  const token = environment.GH_TOKEN ?? environment.GITHUB_TOKEN
  if (typeof token !== 'string' || token.length === 0) return environment
  environment.GIT_CONFIG_COUNT = '1'
  environment.GIT_CONFIG_KEY_0 = 'credential.helper'
  environment.GIT_CONFIG_VALUE_0 = '!gh auth git-credential'
  return environment
}

async function command(
  cwd: string,
  argv: string[],
  input?: string,
  env: Record<string, string | undefined> = trustedEnvironment(),
): Promise<CommandResult> {
  const process = Bun.spawn(argv, {
    cwd,
    env,
    stdin: input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (input !== undefined) {
    if (process.stdin === undefined) throw new Error('command stdin is unavailable')
    process.stdin.write(input)
    process.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { code, stdout, stderr }
}

function commandError(argv: readonly string[], result: CommandResult): Error {
  return new Error(
    `${argv.join(' ')} failed (${result.code}): ${(result.stderr || result.stdout).trim() || '(no output)'}`,
  )
}

async function requiredCommand(cwd: string, argv: string[], input?: string): Promise<string> {
  const result = await command(cwd, argv, input)
  if (result.code !== 0) throw commandError(argv, result)
  return result.stdout
}

function canonicalTaxonomy(toolingRoot: string): string[] {
  const text = readFileSync(join(toolingRoot, TAXONOMY), 'utf8')
  const classes = [...text.matchAll(/^\s*-\s+class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (classes.length === 0 || new Set(classes).size !== classes.length)
    throw new Error('trusted review taxonomy is unreadable')
  return classes
}

async function trustedRoot(expectedSha: string): Promise<string> {
  const root = realpathSync(resolve(import.meta.dirname, '../../..'))
  const actualSha = (await requiredCommand(root, ['git', '-C', root, 'rev-parse', 'HEAD'])).trim()
  if (actualSha !== expectedSha) throw new Error('trusted tooling checkout does not match --tooling-sha')
  const origin = (await requiredCommand(root, ['git', '-C', root, 'remote', 'get-url', 'origin'])).trim()
  if (origin !== 'https://github.com/Roxabi/roxabi-plugins')
    throw new Error('trusted tooling checkout has an unexpected origin')
  return root
}

async function ciState(toolingRoot: string, gh: Gh, pr: number): Promise<'green' | 'red' | 'pending' | 'unknown'> {
  const rollup = await gh(toolingRoot, ['pr', 'view', String(pr), '--json', 'statusCheckRollup'])
  const normalized = await requiredCommand(toolingRoot, ['bash', join(toolingRoot, CI_WATCH), '--checks-of'], rollup)
  const classification = (
    await requiredCommand(toolingRoot, ['bash', join(toolingRoot, CI_WATCH), '--classify-checks'], normalized)
  ).trim()
  if (classification === 'GREEN') return 'green'
  if (classification === 'FAIL') return 'red'
  if (classification === 'PENDING') return 'pending'
  return 'unknown'
}

function proofResult(value: Admission): Result<Json> {
  if (value.ok) return { ok: true, value: value.proof as unknown as Json }
  return {
    ok: false,
    diagnostics: [
      {
        code: value.reason,
        message: value.error,
        detail: { producer: value.producer, reason: value.reason },
      },
    ],
  }
}

/** GH head + base name only. `baseRefOid` is observed, never the normative tip. */
function currentHeadAndBase(raw: string): { head: string; baseName: string; recordedBaseOid: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('GitHub returned unreadable PR coordinates')
  }
  const fields = value as { headRefOid?: unknown; baseRefName?: unknown; baseRefOid?: unknown }
  if (
    !SHA.test(String(fields.headRefOid)) ||
    typeof fields.baseRefName !== 'string' ||
    fields.baseRefName.length === 0 ||
    !SHA.test(String(fields.baseRefOid))
  ) {
    throw new Error('GitHub returned incomplete PR coordinates')
  }
  return {
    head: fields.headRefOid as string,
    baseName: fields.baseRefName,
    recordedBaseOid: fields.baseRefOid as string,
  }
}

async function main(argv: string[]): Promise<MachineResult> {
  const args = parse(argv)
  const toolingRoot = await trustedRoot(args.toolingSha)
  const candidateCwd = realpathSync(args.candidateCwd)
  const gh: Gh = async (_cwd, commandArgs) => {
    const targetArgs =
      commandArgs[0] === 'pr'
        ? [...commandArgs, '--repo', args.repository]
        : commandArgs[0] === 'repo' && commandArgs[1] === 'view' && commandArgs[2]?.startsWith('--')
          ? ['repo', 'view', args.repository, ...commandArgs.slice(2)]
          : commandArgs
    const result = await command(toolingRoot, ['gh', ...targetArgs])
    if (result.code !== 0) throw commandError(['gh', ...targetArgs], result)
    return result.stdout.trim()
  }
  const git: Git = async (cwd, commandArgs) => {
    if (realpathSync(cwd) !== candidateCwd)
      throw new Error('proof admission requested a Git directory other than --candidate-cwd')
    // Verified fetches need process-local gh credential binding under credential-free checkouts.
    return command(
      toolingRoot,
      ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', candidateCwd, ...commandArgs],
      undefined,
      gitFetchEnvironment(),
    )
  }
  const history = await readGitHubHistory(
    githubScope(args.repository, args.pr),
    withRoxabiGitHubPolicy({
      cwd: toolingRoot,
      automationLogin: args.automationLogin,
      gh,
    }),
  )
  const decoded = decodeHistory(history)
  const taxonomy = canonicalTaxonomy(toolingRoot)
  const summary = summarizeReviews(decoded, taxonomy, null)
  if (!summary.ok) return { ok: false, allowed: false, reason: 'review-history-refused', detail: summary.diagnostics }
  const coordinates = currentHeadAndBase(
    await gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
  )
  if (coordinates.head !== args.head) return { ok: false, allowed: false, reason: 'current-head-mismatch' }
  // Normative tip = refreshSelectedBase fetch, never GH baseRefOid (expected stale).
  void coordinates.recordedBaseOid
  const selectedBase = await refreshSelectedBase(candidateCwd, coordinates.baseName, git, gh)
  if (!selectedBase.ok) {
    return {
      ok: false,
      allowed: false,
      reason: 'base-unreadable',
      detail: { producer: selectedBase.producer, reason: selectedBase.reason, error: selectedBase.error },
    }
  }
  const baseTip = selectedBase.tip
  let mandate: LandingMandateDecision | undefined
  let mandateReadError: unknown
  try {
    mandate = await currentLandingMandate(
      toolingRoot,
      args.pr,
      gh,
      { head: args.head, base: coordinates.baseName, baseTip },
      git,
      candidateCwd,
    )
  } catch (error) {
    mandateReadError = error
  }
  const admission = await admitLanding(
    candidateCwd,
    {
      pr: args.pr,
      candidate: args.head,
      base: coordinates.baseName,
      baseTip,
      reviewedAt: summary.value.at,
      reviewInput: summary.value.input,
      ...(mandate?.admitted === true ? { proofPins: mandate.proofPins } : {}),
    },
    { gh, git },
  )
  const ci = await ciState(toolingRoot, gh, args.pr)
  const refreshedHistory = await readGitHubHistory(
    githubScope(args.repository, args.pr),
    withRoxabiGitHubPolicy({
      cwd: toolingRoot,
      automationLogin: args.automationLogin,
      gh,
    }),
  )
  const refreshed = summarizeReviews(decodeHistory(refreshedHistory), taxonomy, null)
  if (!refreshed.ok)
    return { ok: false, allowed: false, reason: 'review-history-refused', detail: refreshed.diagnostics }
  if (JSON.stringify(refreshed.value) !== JSON.stringify(summary.value)) {
    return { ok: false, allowed: false, reason: 'review-inputs-moved' }
  }
  const state = deriveReviewState(
    decodeHistory(refreshedHistory),
    {
      repository: args.repository,
      target: `${args.repository}#${args.pr}`,
      candidateGitSHA: args.head,
      input: refreshed.value.input,
      proofAdmission: proofResult(admission),
      ci,
      acceptedEvidencePolicyRef: null,
    },
    taxonomy,
  )
  const fresh = currentHeadAndBase(
    await gh(toolingRoot, ['pr', 'view', String(args.pr), '--json', 'headRefOid,baseRefName,baseRefOid']),
  )
  if (fresh.head !== args.head || fresh.baseName !== coordinates.baseName) {
    return { ok: false, allowed: false, reason: 'pr-coordinates-moved' }
  }
  // Fresh-vs-fresh fetched tip before allow. Do not refuse baseRefOid != tip.
  void fresh.recordedBaseOid
  const freshBase = await refreshSelectedBase(candidateCwd, fresh.baseName, git, gh)
  if (!freshBase.ok) {
    return {
      ok: false,
      allowed: false,
      reason: 'base-unreadable',
      detail: { producer: freshBase.producer, reason: freshBase.reason, error: freshBase.error },
    }
  }
  if (freshBase.tip !== baseTip) {
    return { ok: false, allowed: false, reason: 'pr-coordinates-moved' }
  }
  if (!state.ok) return { ok: false, allowed: false, reason: 'review-history-refused', detail: state.diagnostics }
  if (state.requiredStop !== null) {
    return {
      ok: false,
      allowed: false,
      reason: state.requiredStop.reason,
      detail: { reviewId: state.requiredStop.reviewId, detail: state.requiredStop.detail },
    }
  }
  if (refreshed.value.head !== args.head) {
    return { ok: false, allowed: false, reason: 'reviewed-head-mismatch' }
  }
  if (mandateReadError !== undefined) {
    return {
      ok: false,
      allowed: false,
      reason: 'unreadable',
      detail: mandateReadError instanceof Error ? mandateReadError.message : String(mandateReadError),
    }
  }
  if (!mandate?.admitted) {
    return {
      ok: false,
      allowed: false,
      reason: mandate?.reason ?? 'unknown-binding',
      detail: jsonDetail(mandate?.evidence),
    }
  }
  if (!admission.ok)
    return {
      ok: false,
      allowed: false,
      reason: 'proof-refused',
      detail: { producer: admission.producer, reason: admission.reason },
    }
  // Native auto-merge owns the known-pending wait. Unknown is not a CI result
  // and therefore never retains an arm.
  const nativeAutoMergePending =
    state.next === 'wait' &&
    state.requiredStop === null &&
    state.summary.head === args.head &&
    state.summary.verdict?.startsWith('Approve') === true &&
    ci === 'pending'
  if (state.next !== 'admit' && !nativeAutoMergePending) {
    return { ok: false, allowed: false, reason: `review-state-${state.next}` }
  }
  const lastMandate = await currentLandingMandate(
    toolingRoot,
    args.pr,
    gh,
    { head: fresh.head, base: fresh.baseName, baseTip: freshBase.tip },
    git,
    candidateCwd,
  )
  if (!lastMandate.admitted) {
    return { ok: false, allowed: false, reason: lastMandate.reason, detail: jsonDetail(lastMandate.evidence) }
  }
  return { ok: true, allowed: true, reviews: state.summary.reviews, ci }
}

try {
  const result = await main(process.argv.slice(2))
  output(result)
  if (!result.ok) process.exitCode = 1
} catch (error) {
  if (process.exitCode !== 1) {
    output({
      ok: false,
      allowed: false,
      reason: 'unreadable',
      detail: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  }
}
