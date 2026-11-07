import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import type { UwDeliveryFacts } from '../../engine/uw-completion-types.ts'
import { type GitHubOptions, gh } from '../github/types.ts'
import { parseJson, splitRepository } from './client.ts'
import { object, SHA } from './types.ts'

type ObservedCommit = UwDeliveryFacts['commits'][number]
type Range = { base: string; head: string }
export type CommitRead =
  | { ok: true; value: ObservedCommit[] }
  | { ok: false; diagnostics: Diagnostic[]; partial: ObservedCommit[] }
type Failure = Extract<CommitRead, { ok: false }>

type Context = {
  options: GitHubOptions
  uw: Scope
  owner: string
  name: string
  strict: boolean
  cache: Map<string, ObservedCommit>
  observed: ObservedCommit[]
  seen: Set<string>
}

function fail(ctx: Context, code: string, message: string): Failure {
  return { ok: false, diagnostics: [{ code, message }], partial: ctx.observed }
}

function observe(ctx: Context, commit: ObservedCommit): void {
  if (!ctx.seen.has(commit.code.commit)) {
    ctx.seen.add(commit.code.commit)
    ctx.observed.push(commit)
  }
}

function parseParents(value: unknown): { sha: string; parents: string[] } | null {
  const item = object(value)
  const sha = item?.sha
  if (item === null || typeof sha !== 'string' || !SHA.test(sha) || !Array.isArray(item.parents)) return null
  const parents: string[] = []
  for (const entry of item.parents) {
    const parent = object(entry)?.sha
    if (typeof parent !== 'string' || !SHA.test(parent)) return null
    parents.push(parent)
  }
  return { sha, parents }
}

function addCommit(ctx: Context, value: unknown): boolean {
  const parsed = parseParents(value)
  if (parsed === null) return false
  const { sha, parents } = parsed
  const key = `${ctx.uw.repository.toLowerCase()}\0${sha}`
  const previous = ctx.cache.get(key)
  if (
    previous &&
    (previous.code.repository !== ctx.uw.repository ||
      previous.parents.length !== parents.length ||
      previous.parents.some((parent, index) => parent !== parents[index]))
  )
    return false
  const candidate = previous ?? { code: { repository: ctx.uw.repository, commit: sha }, parents }
  if (!previous) ctx.cache.set(key, candidate)
  observe(ctx, candidate)
  return true
}

async function readHead(ctx: Context, sha: string): Promise<Failure | null> {
  if (!SHA.test(sha)) return fail(ctx, 'incomplete', `Invalid commit identity ${sha}`)
  const existing = ctx.cache.get(`${ctx.uw.repository.toLowerCase()}\0${sha}`)
  if (existing !== undefined) {
    if (existing.code.repository !== ctx.uw.repository)
      return fail(ctx, 'conflicting-duplicate', `Commit ${sha} repository differs`)
    observe(ctx, existing)
    return null
  }
  const commit = parseJson(
    await gh(ctx.options)(ctx.options.cwd, ['api', `repos/${ctx.owner}/${ctx.name}/git/commits/${sha}`]),
    `commit ${sha}`,
  )
  if (object(commit)?.sha !== sha || !addCommit(ctx, commit))
    return fail(ctx, 'incomplete', `Commit ${sha} has an incorrect identity or incomplete or conflicting parents`)
  return null
}

type Page =
  | { status: 'page'; commits: unknown[]; total: number }
  | { status: 'skip' }
  | { status: 'failed'; failure: Failure }

async function readPage(ctx: Context, range: Range, page: number): Promise<Page> {
  const result = object(
    parseJson(
      await gh(ctx.options)(ctx.options.cwd, [
        'api',
        `repos/${ctx.owner}/${ctx.name}/compare/${range.base}...${range.head}?per_page=100&page=${page}`,
      ]),
      `comparison ${range.base}...${range.head}`,
    ),
  )
  if (
    !result ||
    !Array.isArray(result.commits) ||
    typeof result.total_commits !== 'number' ||
    !Number.isSafeInteger(result.total_commits) ||
    result.total_commits < 0 ||
    !['ahead', 'identical', 'behind', 'diverged'].includes(String(result.status))
  )
    return { status: 'failed', failure: fail(ctx, 'incomplete', `Range ${range.base}...${range.head} is incomplete`) }
  if (result.status !== 'ahead' && result.status !== 'identical')
    return ctx.strict
      ? { status: 'failed', failure: fail(ctx, 'incomplete', `Range ${range.base}...${range.head} is not ancestral`) }
      : { status: 'skip' }
  return { status: 'page', commits: result.commits, total: result.total_commits }
}

function collectPage(ctx: Context, range: Range, values: unknown[], seen: Set<string>): Failure | null {
  for (const commit of values) {
    const sha = object(commit)?.sha
    if (typeof sha !== 'string' || seen.has(sha))
      return fail(ctx, 'conflicting-duplicate', `Range ${range.base}...${range.head} repeated a commit`)
    seen.add(sha)
    if (!addCommit(ctx, commit))
      return fail(ctx, 'incomplete', `Range ${range.base}...${range.head} has incomplete or conflicting commit parents`)
  }
  return null
}

function validatePageCount(
  ctx: Context,
  range: Range,
  result: Extract<Page, { status: 'page' }>,
  count: number,
  total: number | undefined,
): Failure | null {
  if (total !== undefined && total !== result.total)
    return fail(ctx, 'conflicting-duplicate', `Range ${range.base}...${range.head} changed between pages`)
  if (result.commits.length === 0 && count < result.total)
    return fail(ctx, 'incomplete', `Range ${range.base}...${range.head} ended before all commits`)
  return null
}

async function readRange(ctx: Context, range: Range): Promise<Failure | null> {
  const seen = new Set<string>()
  let count = 0
  let total: number | undefined
  for (let page = 1; total === undefined || count < total; page += 1) {
    const result = await readPage(ctx, range, page)
    if (result.status === 'failed') return result.failure
    if (result.status === 'skip') break
    const invalidCount = validatePageCount(ctx, range, result, count, total)
    if (invalidCount !== null) return invalidCount
    total = result.total
    const invalid = collectPage(ctx, range, result.commits, seen)
    if (invalid !== null) return invalid
    count += result.commits.length
    if (count > total) return fail(ctx, 'conflicting-duplicate', `Range ${range.base}...${range.head} repeated commits`)
  }
  return null
}

export function createCommitRangeReader(options: GitHubOptions) {
  const cache = new Map<string, ObservedCommit>()
  return async function readCommitRanges(
    uw: Scope,
    ranges: readonly Range[],
    requiredHeads: readonly string[],
    strict: boolean,
  ): Promise<CommitRead> {
    const ctx: Context = { options, uw, owner: '', name: '', strict, cache, observed: [], seen: new Set() }
    try {
      const repository = splitRepository(uw.repository)
      ctx.owner = repository.owner
      ctx.name = repository.name
      for (const sha of new Set([...requiredHeads, ...ranges.map((range) => range.head)])) {
        const failure = await readHead(ctx, sha)
        if (failure !== null) return failure
      }
      for (const range of ranges) {
        const failure = await readRange(ctx, range)
        if (failure !== null) return failure
      }
    } catch (error) {
      return fail(
        ctx,
        'record-unreadable',
        `Commit range in ${uw.repository}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { ok: true, value: ctx.observed }
  }
}
