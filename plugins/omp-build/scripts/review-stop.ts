#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  buildRecord,
  decodeHistory,
  deriveReviewState,
  githubScope,
  type Json,
  publishGitHubRecord,
  readGitHubHistory,
  summarizeReviews,
} from '../dist/contracts.js'
import { ROXABI_STOP_AUTHOR, withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { loadReviewClassCatalogue } from '../roxabi/review-assets.ts'
import type { ReviewContext } from '../roxabi/review-contract.ts'
import { persistRequiredReviewStop } from '../roxabi/review-dispatch.ts'
import type { Gh } from '../skills/feature/review-base.ts'

const SHA = /^[0-9a-f]{40}$/
const STOP_AUTHOR = ROXABI_STOP_AUTHOR

type Args = {
  repository: string
  pr: number
  head: string
  automationLogin: string
  runId: string
  observation: string
}
type StopObservation = { ok: false; allowed: false; reason: 'ci-failed'; detail: { reviewId: string; detail: Json } }

function parse(argv: string[]): Args {
  const values: Record<string, string | undefined> = {}
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flag?.startsWith('--') || value === undefined || values[flag] !== undefined) throw new Error('usage')
    values[flag] = value
  }
  const repository = values['--repository'] ?? ''
  const pr = Number(values['--pr'])
  const head = values['--head'] ?? ''
  const automationLogin = values['--automation-login'] ?? ''
  const runId = values['--run-id'] ?? ''
  const observation = values['--observation'] ?? ''
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(pr) ||
    pr < 1 ||
    !SHA.test(head) ||
    !automationLogin ||
    !runId ||
    !observation
  )
    throw new Error('usage')
  return { repository, pr, head, automationLogin, runId, observation }
}

function observed(path: string): StopObservation {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<StopObservation>
  if (
    value.ok !== false ||
    value.allowed !== false ||
    value.reason !== 'ci-failed' ||
    typeof value.detail?.reviewId !== 'string'
  )
    throw new Error('observation is not a ci-failed required stop')
  return value as StopObservation
}

async function gh(cwd: string, repository: string, args: string[]): Promise<string> {
  const env = { ...process.env }
  delete env.GH_TOKEN
  env.GITHUB_TOKEN = env.STOP_GH_TOKEN
  const targetArgs =
    args[0] === 'pr'
      ? [...args, '--repo', repository]
      : args[0] === 'repo' && args[1] === 'view' && args[2]?.startsWith('--')
        ? ['repo', 'view', repository, ...args.slice(2)]
        : args
  const proc = Bun.spawn(['gh', ...targetArgs], { cwd, env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`gh ${targetArgs.join(' ')} failed (${code}): ${stderr || stdout}`)
  return stdout.trim()
}

function taxonomy(cwd: string): string[] {
  const { classes } = loadReviewClassCatalogue(join(cwd, 'plugins/omp-build/skills/dev-review'))
  const taxonomy = [...classes.matchAll(/^\s*-\s+class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (taxonomy.length === 0) throw new Error('trusted review taxonomy is unreadable')
  return taxonomy
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2))
  const cwd = resolve(import.meta.dirname, '../../..')
  const observation = observed(args.observation)
  const scope = githubScope(args.repository, args.pr)
  const scopedGh: Gh = (callCwd, commandArgs) => gh(callCwd, args.repository, commandArgs)
  const canonicalClasses = taxonomy(cwd)
  const history = decodeHistory(
    await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd, readAuthor: args.automationLogin, gh: scopedGh })),
  )
  const summary = summarizeReviews(history, canonicalClasses, null)
  if (!summary.ok) throw new Error('fresh review history refused stop publication')
  const coordinates = JSON.parse(await scopedGh(cwd, ['pr', 'view', String(args.pr), '--json', 'headRefOid'])) as {
    headRefOid?: unknown
  }
  if (coordinates.headRefOid !== args.head) throw new Error('PR head moved before stop publication')
  if (summary.value.head !== args.head) throw new Error('reviewed head does not bind this CI stop')
  const state = deriveReviewState(
    history,
    {
      ...scope,
      candidateGitSHA: args.head,
      input: summary.value.input,
      ci: 'red',
      acceptedEvidencePolicyRef: null,
    },
    canonicalClasses,
  )
  if (!state.ok) throw new Error('fresh review state is invalid')
  const requiredStop = state.requiredStop
  if (
    requiredStop === null ||
    requiredStop.reason !== 'ci-failed' ||
    requiredStop.reviewId !== observation.detail.reviewId ||
    JSON.stringify(requiredStop.detail) !== JSON.stringify(observation.detail.detail)
  )
    throw new Error('fresh review state no longer matches observed ci-failed stop')
  const operationId = `ci-stop-${requiredStop.reviewId}`
  const context: ReviewContext = {
    operationId,
    runId: `ci-${args.runId}`,
    repository: args.repository,
    target: scope.target,
    candidateGitSHA: args.head,
    input: summary.value.input,
    subject: { kind: 'pull-request' },
  }
  const result = await persistRequiredReviewStop(context, requiredStop, {
    async authorize() {
      return { ok: true }
    },
    async publishRequiredStop() {
      const draft = {
        ...scope,
        version: 1,
        recordId: operationId,
        runId: context.runId,
        operationId,
        kind: 'stop',
        payload: requiredStop,
      } as const
      const built = buildRecord(draft)
      if (!built.ok) return { ok: false, reason: 'invalid-stop-record' }
      const published = await publishGitHubRecord(
        built.value,
        history,
        withRoxabiGitHubPolicy({ cwd, gh: scopedGh, readAuthor: args.automationLogin, writerLogin: STOP_AUTHOR }),
        null,
      )
      return published.status === 'confirmed' ? { ok: true } : { ok: false, reason: published.status }
    },
  })
  if (!result.ok) throw new Error(`stop publication refused: ${result.reason}`)
  process.stdout.write(`${JSON.stringify({ ok: true, stop: requiredStop })}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
