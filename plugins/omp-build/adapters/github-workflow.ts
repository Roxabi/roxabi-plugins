import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DecodedHistory, History } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Diagnostic, Json, Scope } from '../engine/record-values.ts'
import type { RecordProjectionConfig } from '../engine/result.ts'
import { selectWorkflowBinding } from '../engine/workflow-pr-binding.ts'
import {
  decodeHistory,
  type Gh,
  GitHubHistoryReadError,
  type GitHubOptions,
  githubScope,
  publishGitHubRecord,
  readGitHubHistory,
} from './github.ts'

const execFileAsync = promisify(execFile)

export type LinkedIssueAssociation =
  | { status: 'linked'; scope: Scope; number: number }
  | { status: 'none' }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable'; diagnostics: Diagnostic[] }

export type NativePullRequestFacts = {
  repository: string
  pr: number
  head: string
  base: string
  baseTip: string
  branch: string
  state: string
  author: string | null
}

export type NativeIssueFacts = {
  repository: string
  number: number
  state: string
  author: string | null
  body: string
  isPullRequest: boolean
}

export type NativeTargetResolution =
  | { status: 'issue'; scope: Scope; issue: NativeIssueFacts }
  | { status: 'pull-request'; scope: Scope; pullRequest: NativePullRequestFacts }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable' | 'refused'; diagnostics: Diagnostic[] }

export type IssueParentAssociation =
  | { status: 'linked'; scope: Scope; number: number }
  | { status: 'none' }
  | { status: 'ambiguous' | 'incomplete' | 'unreadable'; diagnostics: Diagnostic[] }

export type ComposedWorkflowHistory =
  | { ok: true; scopes: Scope[]; histories: DecodedHistory[]; records: CanonicalRecord[] }
  | {
      ok: false
      reason: 'incomplete' | 'ambiguous' | 'unreadable'
      diagnostics: Diagnostic[]
      histories: DecodedHistory[]
      evidence?: Json
    }

export type LandingFactsRead =
  | {
      ok: true
      /** Authenticated records are derived from these histories only. */
      histories: DecodedHistory[]
      /** Exact requireLandingMandate.native; GH numbers stay adapter-private. */
      native: {
        branch: string
        base: string
        pullRequest: Scope
        linkedIssueScopes: Scope[]
      }
      /** Observed PR tips for product gates; never copied into engine native. */
      observed: {
        head: string
        baseTip: string
      }
      /** Exact live issue bodies for the bound mandate scope. */
      linkedIssueBodies: { scope: Scope; body: string }[]
      /** Explicit mandate.parent scopes. Empty means no delivery parent; missing is not empty. */
      parentScopes: Scope[]
      /** Applicable PR workflow-binding. Predecessor records may remain in histories. */
      binding: CanonicalRecord
    }
  | {
      ok: false
      reason: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'ambiguous' | 'unreadable'
      diagnostics: Diagnostic[]
      evidence?: Json
    }

export type WorkflowPublication =
  | { status: 'confirmed'; operation: DecodedHistory['operations'][number] }
  | { status: 'uncertain' | 'refused'; history: DecodedHistory; diagnostics: Diagnostic[] }

const RECORD_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[0-9a-f]{40}$/
const POSITIVE_INT = /^[1-9][0-9]*$/

const CLOSING_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefName
      baseRefName
      headRefOid
      baseRefOid
      closingIssuesReferences(first: 25) {
        totalCount
        nodes { number }
      }
    }
  }
}`

const PARENT_ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      parent {
        number
        repository { nameWithOwner }
      }
    }
  }
}`

function diagnostic(code: string, message: string, detail?: Json): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function defaultGh(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) =>
    String(stdout).trim(),
  )
}

function gh(options: GitHubOptions): Gh {
  return options.gh ?? defaultGh
}

function splitRepository(repository: string): { owner: string; name: string } {
  if (!RECORD_REPOSITORY.test(repository)) {
    throw new GitHubHistoryReadError('GitHub repository is invalid', [
      diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
    ])
  }
  const [owner, name] = repository.split('/')
  if (!owner || !name) {
    throw new GitHubHistoryReadError('GitHub repository is invalid', [
      diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
    ])
  }
  return { owner, name }
}

function scopeNumber(scope: Scope): number {
  const separator = scope.target.lastIndexOf('#')
  const repository = separator > 0 ? scope.target.slice(0, separator) : ''
  const number = separator > 0 ? Number(scope.target.slice(separator + 1)) : Number.NaN
  if (
    !RECORD_REPOSITORY.test(scope.repository) ||
    repository !== scope.repository ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new GitHubHistoryReadError('GitHub scope is invalid', [
      diagnostic('invalid-scope', `Scope ${scope.target} is not a GitHub repository issue target`),
    ])
  }
  return number
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new GitHubHistoryReadError(`${label} is not JSON`, [
      diagnostic('invalid-github-response', `${label} is not valid JSON`),
    ])
  }
}

async function graphql(
  options: GitHubOptions,
  query: string,
  variables: { owner: string; name: string; number: number },
): Promise<unknown> {
  const raw = await gh(options)(options.cwd, [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${variables.owner}`,
    '-f',
    `name=${variables.name}`,
    '-F',
    `number=${variables.number}`,
  ])
  const parsed = object(parseJson(raw, 'GitHub GraphQL response'))
  if (parsed === null) {
    throw new GitHubHistoryReadError('GitHub GraphQL response is invalid', [
      diagnostic('invalid-github-response', 'GraphQL response is not an object'),
    ])
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new GitHubHistoryReadError('GitHub GraphQL returned errors', [
      diagnostic('github-read-failed', 'GraphQL errors prevent a complete native read', parsed.errors as Json),
    ])
  }
  if (!('data' in parsed) || parsed.data === null || parsed.data === undefined) {
    throw new GitHubHistoryReadError('GitHub GraphQL data is absent', [
      diagnostic('incomplete', 'GraphQL data is absent'),
    ])
  }
  return parsed.data
}

function referenceNumber(reference: string | number): number | null {
  if (typeof reference === 'number') {
    return Number.isSafeInteger(reference) && reference >= 1 ? reference : null
  }
  const trimmed = reference.trim()
  const match = /^(?:#|pr\/|issue\/)?([1-9][0-9]*)$/i.exec(trimmed)
  if (match === null) return null
  const number = Number(match[1])
  return Number.isSafeInteger(number) ? number : null
}

async function resolveRepository(options: GitHubOptions, repository?: string): Promise<string> {
  if (repository !== undefined) {
    if (!RECORD_REPOSITORY.test(repository)) {
      throw new GitHubHistoryReadError('GitHub repository is invalid', [
        diagnostic('invalid-scope', `Repository ${repository} is not owner/name`),
      ])
    }
    return repository
  }
  const raw = await gh(options)(options.cwd, ['repo', 'view', '--json', 'nameWithOwner'])
  const parsed = object(parseJson(raw, 'gh repo view'))
  const nameWithOwner = parsed?.nameWithOwner
  if (typeof nameWithOwner !== 'string' || !RECORD_REPOSITORY.test(nameWithOwner)) {
    throw new GitHubHistoryReadError('GitHub repository identity is unreadable', [
      diagnostic('unreadable', 'gh repo view did not return nameWithOwner'),
    ])
  }
  return nameWithOwner
}

/** Read native issue metadata. A pull request issue payload is reported, not rewritten. */
export async function readNativeIssueFacts(
  repository: string,
  number: number,
  options: GitHubOptions,
): Promise<NativeIssueFacts> {
  if (!POSITIVE_INT.test(String(number))) {
    throw new GitHubHistoryReadError('GitHub issue number is invalid', [
      diagnostic('invalid-scope', `Issue number ${number} is invalid`),
    ])
  }
  const raw = await gh(options)(options.cwd, ['api', `repos/${repository}/issues/${number}`])
  const parsed = object(parseJson(raw, `issue #${number}`))
  const user = object(parsed?.user)
  const author = typeof user?.login === 'string' ? user.login : null
  const state = parsed?.state
  const returnedNumber = parsed?.number
  const body = parsed?.body
  if (
    parsed === null ||
    returnedNumber !== number ||
    (state !== 'open' && state !== 'closed') ||
    typeof state !== 'string' ||
    typeof body !== 'string'
  ) {
    throw new GitHubHistoryReadError(`Issue #${number} is unreadable`, [
      diagnostic('unreadable', `Issue #${number} native payload is incomplete`),
    ])
  }
  return {
    repository,
    number,
    state: state.toUpperCase(),
    author,
    body,
    isPullRequest: object(parsed.pull_request) !== null,
  }
}

/** Fail-closed exact issue body reader for an opaque Scope. Missing body refuses. */
export async function readScopeIssueBody(scope: Scope, options: GitHubOptions): Promise<string> {
  const facts = await readNativeIssueFacts(scope.repository, scopeNumber(scope), options)
  return facts.body
}

/** Read native pull-request head/base/branch facts. Missing fields refuse. */
export async function readNativePullRequestFacts(
  repository: string,
  pr: number,
  options: GitHubOptions,
): Promise<NativePullRequestFacts> {
  if (!POSITIVE_INT.test(String(pr))) {
    throw new GitHubHistoryReadError('GitHub pull request number is invalid', [
      diagnostic('invalid-scope', `Pull request number ${pr} is invalid`),
    ])
  }
  const raw = await gh(options)(options.cwd, [
    'pr',
    'view',
    String(pr),
    '--repo',
    repository,
    '--json',
    'number,state,headRefOid,headRefName,baseRefName,baseRefOid,author',
  ])
  const parsed = object(parseJson(raw, `pull request #${pr}`))
  const authorObject = object(parsed?.author)
  const author = typeof authorObject?.login === 'string' ? authorObject.login : null
  const number = parsed?.number
  const state = parsed?.state
  const head = parsed?.headRefOid
  const branch = parsed?.headRefName
  const base = parsed?.baseRefName
  const baseTip = parsed?.baseRefOid
  if (
    number !== pr ||
    typeof state !== 'string' ||
    typeof head !== 'string' ||
    !SHA.test(head) ||
    typeof branch !== 'string' ||
    branch.length === 0 ||
    typeof base !== 'string' ||
    base.length === 0 ||
    typeof baseTip !== 'string' ||
    !SHA.test(baseTip)
  ) {
    throw new GitHubHistoryReadError(`Pull request #${pr} is unreadable`, [
      diagnostic('unreadable', `Pull request #${pr} native head/base facts are incomplete`),
    ])
  }
  return { repository, pr, head, base, baseTip, branch, state, author }
}

/**
 * Resolve an explicit operator reference to an existing issue or PR.
 * Fix-only may target either; this never creates a ticket.
 */
export async function resolveNativeTarget(
  reference: string | number,
  options: GitHubOptions,
  repository?: string,
): Promise<NativeTargetResolution> {
  try {
    const number = referenceNumber(reference)
    if (number === null) {
      return {
        status: 'refused',
        diagnostics: [diagnostic('invalid-reference', `Reference ${JSON.stringify(reference)} is not an issue or PR`)],
      }
    }
    const resolvedRepository = await resolveRepository(options, repository)
    const issue = await readNativeIssueFacts(resolvedRepository, number, options)
    if (!issue.isPullRequest) {
      return { status: 'issue', scope: githubScope(resolvedRepository, number), issue }
    }
    const pullRequest = await readNativePullRequestFacts(resolvedRepository, number, options)
    return { status: 'pull-request', scope: githubScope(resolvedRepository, number), pullRequest }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      const codes = new Set(error.diagnostics.map((entry) => entry.code))
      const status = codes.has('incomplete') ? 'incomplete' : codes.has('ambiguous') ? 'ambiguous' : 'unreadable'
      return { status, diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

/**
 * Resolve a previously recorded GitHub scope without interpreting it as an
 * operator reference. Its repository and target must agree exactly; resolution
 * never falls back to the repository inferred from the current working tree.
 */
export async function resolveNativeScope(scope: Scope, options: GitHubOptions): Promise<NativeTargetResolution> {
  try {
    return await resolveNativeTarget(scopeNumber(scope), options, scope.repository)
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: 'refused', diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

/**
 * Observe native PR→issue association from closingIssuesReferences only.
 * Absence is `none`, never approval or a synthetic mandate. Ambiguity and
 * incomplete pagination remain explicit.
 *
 * GitHub interprets closing keywords only when the PR targets the default
 * branch. On any other base those keywords create no link. This reader does
 * not parse PR body or branch names to invent one. A non-default base remains
 * a valid coordinate; a node the API actually returns is kept.
 */
export async function readLinkedIssueAssociation(
  repository: string,
  pr: number,
  options: GitHubOptions,
): Promise<LinkedIssueAssociation> {
  try {
    const { owner, name } = splitRepository(repository)
    const pullFacts = await readNativePullRequestFacts(repository, pr, options)
    const data = object(await graphql(options, CLOSING_ISSUES_QUERY, { owner, name, number: pr }))
    const repo = object(data?.repository)
    const pull = object(repo?.pullRequest)
    const closing = object(pull?.closingIssuesReferences)
    const nodes = Array.isArray(closing?.nodes) ? closing.nodes : null
    const totalCount = closing?.totalCount
    const headRefName = pull?.headRefName
    const baseRefName = pull?.baseRefName
    const headRefOid = pull?.headRefOid
    const baseRefOid = pull?.baseRefOid
    if (
      pull === null ||
      closing === null ||
      nodes === null ||
      typeof totalCount !== 'number' ||
      !Number.isSafeInteger(totalCount) ||
      totalCount !== nodes.length ||
      headRefName !== pullFacts.branch ||
      baseRefName !== pullFacts.base ||
      headRefOid !== pullFacts.head ||
      baseRefOid !== pullFacts.baseTip
    ) {
      return {
        status: 'incomplete',
        diagnostics: [
          diagnostic(
            'incomplete',
            `PR #${pr} closing-issue association is incomplete or conflicts with head/base facts`,
          ),
        ],
      }
    }
    if (totalCount > 25) {
      return {
        status: 'incomplete',
        diagnostics: [diagnostic('incomplete', `PR #${pr} has more closing issues than one page can prove`)],
      }
    }
    const numbers: number[] = []
    for (const node of nodes) {
      const entry = object(node)
      if (
        entry === null ||
        typeof entry.number !== 'number' ||
        !Number.isSafeInteger(entry.number) ||
        entry.number < 1
      ) {
        return {
          status: 'unreadable',
          diagnostics: [diagnostic('unreadable', `PR #${pr} closing-issue node is unreadable`)],
        }
      }
      numbers.push(entry.number)
    }
    const unique = [...new Set(numbers)]
    if (unique.length === 0) return { status: 'none' }
    if (unique.length > 1) {
      return {
        status: 'ambiguous',
        diagnostics: [diagnostic('ambiguous', `PR #${pr} closes multiple issues`, { numbers: unique })],
      }
    }
    const linked = unique[0]
    if (linked === undefined) return { status: 'none' }
    return { status: 'linked', scope: githubScope(repository, linked), number: linked }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: 'unreadable', diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

/** Observe native issue parent association for root/child mandate binding. */
export async function readIssueParentAssociation(
  repository: string,
  number: number,
  options: GitHubOptions,
): Promise<IssueParentAssociation> {
  try {
    const { owner, name } = splitRepository(repository)
    const data = object(await graphql(options, PARENT_ISSUE_QUERY, { owner, name, number }))
    const repo = object(data?.repository)
    const issue = object(repo?.issue)
    if (issue === null || issue.number !== number) {
      return {
        status: 'unreadable',
        diagnostics: [diagnostic('unreadable', `Issue #${number} parent association is unreadable`)],
      }
    }
    if (!('parent' in issue) || issue.parent === null || issue.parent === undefined) {
      return { status: 'none' }
    }
    const parent = object(issue.parent)
    const parentRepo = object(parent?.repository)
    const parentNumber = parent?.number
    const parentRepository = parentRepo?.nameWithOwner
    if (
      parent === null ||
      typeof parentNumber !== 'number' ||
      !Number.isSafeInteger(parentNumber) ||
      parentNumber < 1 ||
      typeof parentRepository !== 'string' ||
      !RECORD_REPOSITORY.test(parentRepository)
    ) {
      return {
        status: 'unreadable',
        diagnostics: [diagnostic('unreadable', `Issue #${number} parent payload is incomplete`)],
      }
    }
    return { status: 'linked', scope: githubScope(parentRepository, parentNumber), number: parentNumber }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) {
      return { status: 'unreadable', diagnostics: error.diagnostics }
    }
    return {
      status: 'unreadable',
      diagnostics: [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))],
    }
  }
}

function collectRecords(histories: readonly DecodedHistory[]): {
  records: CanonicalRecord[]
  diagnostics: Diagnostic[]
} {
  const records: CanonicalRecord[] = []
  const diagnostics: Diagnostic[] = []
  const byRecordId = new Map<string, CanonicalRecord>()
  for (const history of histories) {
    if (!history.source.complete) {
      diagnostics.push(
        diagnostic('incomplete', `History for ${history.source.scope.target} is not a complete native read`),
      )
      continue
    }
    for (const operation of history.operations) {
      if (operation.status === 'incomplete' || operation.status === 'conflict') {
        diagnostics.push(
          diagnostic(
            operation.status === 'incomplete' ? 'incomplete' : 'ambiguous',
            `Operation ${operation.operationId ?? 'unknown'} on ${history.source.scope.target} is ${operation.status}`,
          ),
        )
        continue
      }
      if (operation.status !== 'complete' || operation.record === null) continue
      const existing = byRecordId.get(operation.record.recordId)
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(operation.record)) {
        diagnostics.push(
          diagnostic(
            'ambiguous',
            `Record ${operation.record.recordId} has conflicting complete publications across scopes`,
          ),
        )
        continue
      }
      if (existing === undefined) {
        byRecordId.set(operation.record.recordId, operation.record)
        records.push(operation.record)
      }
    }
    diagnostics.push(...history.diagnostics)
  }
  return { records, diagnostics }
}

/**
 * Compose only the linked scopes actually required. Scopes stay opaque outside
 * this adapter; callers pass Scope values from githubScope / native association.
 */
export async function readComposedWorkflowHistory(
  scopes: readonly Scope[],
  options: GitHubOptions,
): Promise<ComposedWorkflowHistory> {
  if (scopes.length === 0) {
    return {
      ok: false,
      reason: 'incomplete',
      diagnostics: [diagnostic('incomplete', 'Composed workflow history requires at least one scope')],
      histories: [],
    }
  }
  const uniqueTargets = new Set(scopes.map((scope) => scope.target))
  if (uniqueTargets.size !== scopes.length) {
    return {
      ok: false,
      reason: 'ambiguous',
      diagnostics: [diagnostic('ambiguous', 'Composed workflow history received duplicate scopes')],
      histories: [],
    }
  }
  const histories: DecodedHistory[] = []
  try {
    for (const scope of scopes) {
      const source: History = await readGitHubHistory(scope, options)
      if (!source.complete) {
        return {
          ok: false,
          reason: 'incomplete',
          diagnostics: [diagnostic('incomplete', `Native history for ${scope.target} is incomplete`)],
          histories,
          evidence: { scope },
        }
      }
      histories.push(decodeHistory(source))
    }
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return { ok: false, reason: 'unreadable', diagnostics, histories }
  }
  const collected = collectRecords(histories)
  const blocking = collected.diagnostics.filter(
    (entry) => entry.code === 'incomplete' || entry.code === 'ambiguous' || entry.code === 'conflicting-duplicate',
  )
  if (blocking.length > 0) {
    const reason = blocking.some((entry) => entry.code === 'ambiguous' || entry.code === 'conflicting-duplicate')
      ? 'ambiguous'
      : 'incomplete'
    return { ok: false, reason, diagnostics: collected.diagnostics, histories }
  }
  return { ok: true, scopes: [...scopes], histories, records: collected.records }
}

export type WorkflowBindingRead =
  | {
      ok: true
      value: {
        binding: CanonicalRecord
        history: DecodedHistory
        histories: DecodedHistory[]
        linkedIssueBodies: { scope: Scope; body: string }[]
        parentScopes: Scope[]
        native: Extract<LandingFactsRead, { ok: true }>['native']
        observed: { head: string; baseTip: string }
      }
    }
  | {
      ok: false
      status: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'unreadable'
      reason: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'unreadable'
      diagnostics: Diagnostic[]
      evidence?: Json
    }

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function refKey(ref: ExternalRecordRef): string {
  return `${ref.kind}\0${ref.scope.repository}\0${ref.scope.target}\0${ref.recordId}`
}

function bindingRefusal(
  status: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'unreadable',
  diagnostics: Diagnostic[],
  evidence?: Json,
): WorkflowBindingRead {
  return evidence === undefined
    ? { ok: false, status, reason: status, diagnostics }
    : { ok: false, status, reason: status, diagnostics, evidence }
}

function historyFor(scope: Scope, histories: readonly DecodedHistory[]): DecodedHistory | null {
  return histories.find((history) => sameScope(history.source.scope, scope)) ?? null
}

function confirmedMandate(
  history: DecodedHistory,
  ref: ExternalRecordRef,
): Extract<CanonicalRecord, { kind: 'mandate' }> | null {
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.authority !== 'accounted' || operation.record === null) continue
    if (operation.record.kind !== 'mandate' || operation.record.recordId !== ref.recordId) continue
    if (!sameScope(operation.record, ref.scope)) continue
    return operation.record
  }
  return null
}

/**
 * Confirmed PR workflow-binding via selectWorkflowBinding, then explicit parent
 * history expansion. closingIssuesReferences is not authority. Tracker parentage
 * is not authority. Zero claims are absent. A present invalid claim is never absent.
 */
export async function readWorkflowBinding(prScope: Scope, options: GitHubOptions): Promise<WorkflowBindingRead> {
  try {
    const pr = scopeNumber(prScope)
    const pullRequest = await readNativePullRequestFacts(prScope.repository, pr, options)
    const prHistory = decodeHistory(await readGitHubHistory(prScope, options))
    if (!prHistory.source.complete) {
      return bindingRefusal('incomplete', [diagnostic('incomplete', 'PR history is incomplete')])
    }
    const mandateHistories: DecodedHistory[] = []
    let selected = selectWorkflowBinding({
      pullRequest: prScope,
      histories: [prHistory],
      native: { branch: pullRequest.branch, base: pullRequest.base },
    })
    if (selected.status === 'incomplete') {
      for (const operation of prHistory.operations) {
        const record = operation.record
        if (record?.kind !== 'workflow-binding') continue
        const mandateScope = record.payload.mandate.scope
        if (historyFor(mandateScope, [prHistory, ...mandateHistories]) !== null) continue
        const history = decodeHistory(await readGitHubHistory(mandateScope, options))
        if (!history.source.complete) {
          return bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate history is incomplete')])
        }
        mandateHistories.push(history)
      }
      selected = selectWorkflowBinding({
        pullRequest: prScope,
        histories: [prHistory, ...mandateHistories],
        native: { branch: pullRequest.branch, base: pullRequest.base },
      })
    }
    if (selected.status !== 'bound') {
      return bindingRefusal(
        selected.status,
        selected.status === 'absent' ? [diagnostic('absent', 'PR has no workflow-binding')] : selected.diagnostics,
      )
    }
    const mandateHistory = historyFor(selected.mandate.scope, [prHistory, ...mandateHistories])
    if (mandateHistory === null) {
      return bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate history is missing')])
    }
    const mandate = selected.mandateRecord
    const parentScopes: Scope[] = []
    const parentHistories: DecodedHistory[] = []
    let parent = mandate.payload.parent
    const seenParents = new Set<string>()
    while (parent !== null) {
      if (parent.kind !== 'mandate') {
        return bindingRefusal('conflicting', [diagnostic('kind-mismatch', 'Mandate parent is not a mandate')])
      }
      const key = refKey(parent)
      if (seenParents.has(key)) {
        return bindingRefusal('conflicting', [diagnostic('conflicting', 'Mandate parent chain cycles')])
      }
      seenParents.add(key)
      let parentHistory = historyFor(parent.scope, [prHistory, ...mandateHistories, ...parentHistories])
      if (parentHistory === null) {
        parentHistory = decodeHistory(await readGitHubHistory(parent.scope, options))
        if (!parentHistory.source.complete) {
          return bindingRefusal('incomplete', [diagnostic('incomplete', 'Parent mandate history is incomplete')])
        }
        parentHistories.push(parentHistory)
      }
      const parentRecord = confirmedMandate(parentHistory, parent)
      if (parentRecord === null) {
        return bindingRefusal('incomplete', [diagnostic('incomplete', 'Parent mandate record is not confirmed')])
      }
      parentScopes.push(parent.scope)
      parent = parentRecord.payload.parent
    }
    let body: string
    try {
      body = await readScopeIssueBody(selected.mandate.scope, options)
    } catch (error) {
      const diagnostics =
        error instanceof GitHubHistoryReadError
          ? error.diagnostics
          : [diagnostic('unreadable', error instanceof Error ? error.message : String(error))]
      return bindingRefusal('unreadable', diagnostics, { scope: selected.mandate.scope })
    }
    const histories = [prHistory]
    for (const history of [...mandateHistories, ...parentHistories]) {
      if (histories.some((existing) => sameScope(existing.source.scope, history.source.scope))) continue
      histories.push(history)
    }
    return {
      ok: true,
      value: {
        binding: selected.binding,
        history: mandateHistory,
        histories,
        linkedIssueBodies: [{ scope: selected.mandate.scope, body }],
        parentScopes,
        native: {
          branch: pullRequest.branch,
          base: pullRequest.base,
          pullRequest: prScope,
          linkedIssueScopes: [selected.mandate.scope],
        },
        observed: { head: pullRequest.head, baseTip: pullRequest.baseTip },
      },
    }
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return bindingRefusal('unreadable', diagnostics)
  }
}

/**
 * Cold landing read. Admission is the confirmed workflow-binding, then its
 * mandate and explicit parent refs. Native closing links are not authority.
 */
export async function readLandingFacts(prScope: Scope, options: GitHubOptions): Promise<LandingFactsRead> {
  const bound = await readWorkflowBinding(prScope, options)
  if (!bound.ok) {
    return {
      ok: false,
      reason: bound.reason === 'unconfirmed' ? 'unconfirmed' : bound.reason,
      diagnostics: bound.diagnostics,
      evidence: bound.evidence,
    }
  }
  return {
    ok: true,
    histories: bound.value.histories,
    native: bound.value.native,
    observed: bound.value.observed,
    linkedIssueBodies: bound.value.linkedIssueBodies,
    parentScopes: bound.value.parentScopes,
    binding: bound.value.binding,
  }
}

/**
 * Publish a workflow record through the canonical codec/publisher only.
 * Supplies externalHistories to projection/ref validation. Publication confirms
 * record refs and read-back; it does not authorize the next action. Confirmed
 * read-back is required; uncertain/refused never mint a checkpoint. Partial
 * same-operation resume semantics are preserved by publishGitHubRecord.
 */
export async function publishConfirmedWorkflowRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  options: GitHubOptions,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<WorkflowPublication> {
  return publishGitHubRecord(record, history, options, config, externalHistories)
}
