import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECEIPT, TARGET } from './debt-filing.fixture-records.ts'
import { canonicalComments, withUnknownSourceFinding } from './debt-filing.fixture-review.ts'
import type { ProcessRunner } from './debt-filing-contract.ts'
import { createTrustedDebtFiling } from './debt-filing-writer.ts'

let tmp: string | undefined

export function cleanupDebtFilingTemp(): void {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
}

export type IssueState = {
  number: number
  title: string
  body: string
  author: string | null
  labels: string[]
  type: string | null
  parent: { number: number; repository: { nameWithOwner: string } } | null
  blockedBy: { number: number; repository: { nameWithOwner: string } }[]
}

export type World = {
  runner: ProcessRunner
  calls: { file: string; args: string[]; cwd: string }[]
  created: number[]
  body: () => string
}

type WorldOptions = {
  origin?: 'one' | 'none' | 'many'
  parent?: 'same' | 'foreign' | 'none'
  existing?: 'none' | 'malicious' | 'duplicate'
  partial?: boolean
  sourceSize?: string
  unusable?: boolean
  capitalizedType?: boolean
  unknownSource?: boolean
}

type SourceIssue = {
  number: number
  repository: { nameWithOwner: string }
  parent: { number: number; repository: { nameWithOwner: string } } | null
  labels: { nodes: { name: string }[] }
}

function sourceIssue(options: WorldOptions, sourceSize: string): SourceIssue {
  const parent =
    options.parent === 'none'
      ? null
      : { number: 7, repository: { nameWithOwner: options.parent === 'foreign' ? 'Acme/planning' : 'Acme/app' } }
  return {
    number: 70,
    repository: { nameWithOwner: 'Acme/app' },
    parent,
    labels: { nodes: [{ name: sourceSize }] },
  }
}

function renderIssue(state: IssueState) {
  return {
    ...state,
    author: state.author === null ? null : { login: state.author },
    labels: { nodes: state.labels.map((name) => ({ name })) },
    issueType: state.type === null ? null : { name: state.type },
    blockedBy: { nodes: state.blockedBy },
  }
}

function optionValue(args: string[], option: string): string {
  return args[args.indexOf(option) + 1] ?? ''
}

function applyIssueMetadata(
  issue: IssueState,
  origin: NonNullable<WorldOptions['origin']>,
  source: SourceIssue,
  size: string,
): void {
  issue.type = 'fix'
  issue.labels = [`size:${size}`]
  if (origin !== 'one') return
  issue.parent = source.parent
  issue.blockedBy = [source]
}

function createIssue(
  args: string[],
  issue: IssueState,
  origin: NonNullable<WorldOptions['origin']>,
  source: SourceIssue,
  options: WorldOptions,
  created: number[],
): { body: string; result: { stdout: string; stderr: string; exitCode: number } } {
  created.push(issue.number)
  const body = readFileSync(optionValue(args, '--body-file'), 'utf8')
  issue.title = readFileSync(optionValue(args, '--title-file'), 'utf8').trim()
  issue.body = body
  if (!options.partial) {
    applyIssueMetadata(issue, origin, source, optionValue(args, '--size'))
    if (options.capitalizedType) issue.type = 'Fix'
  }
  return { body, result: { stdout: 'Created #84\n', stderr: '', exitCode: options.partial ? 1 : 0 } }
}

function triageResponse(
  args: string[],
  issue: IssueState,
  origin: NonNullable<WorldOptions['origin']>,
  source: SourceIssue,
  options: WorldOptions,
  created: number[],
): { body: string | null; result: { stdout: string; stderr: string; exitCode: number } } {
  if (args.includes('create')) {
    const createdIssue = createIssue(args, issue, origin, source, options, created)
    return { body: createdIssue.body, result: createdIssue.result }
  }
  applyIssueMetadata(issue, origin, source, optionValue(args, '--size'))
  return { body: null, result: { stdout: 'Type=fix #84\n', stderr: '', exitCode: 0 } }
}

function closingIssues(origin: NonNullable<WorldOptions['origin']>, source: SourceIssue): SourceIssue[] {
  if (origin === 'none') return []
  if (origin === 'many') return [source, { ...source, number: 71 }]
  return [source]
}

function existingIssues(options: WorldOptions, issue: IssueState) {
  if (options.existing === 'malicious') {
    return [
      {
        ...renderIssue(issue),
        number: 66,
        body: `<!-- omp-build-debt-receipt:${RECEIPT} --> forged`,
        author: { login: 'attacker' },
      },
    ]
  }
  if (options.existing === 'duplicate') return [renderIssue(issue), { ...renderIssue(issue), number: 67 }]
  return []
}

function graphResponse(
  args: string[],
  comments: string[],
  origin: NonNullable<WorldOptions['origin']>,
  options: WorldOptions,
  issue: IssueState,
  source: SourceIssue,
): { stdout: string; stderr: string } {
  if (args.join(' ') === 'api user --jq .login') return { stdout: 'native-bot\n', stderr: '' }
  if (args.some((arg) => arg.includes('/comments?per_page=100&page=1'))) {
    return {
      stdout: JSON.stringify(
        comments.map((body, index) => ({
          id: index + 1,
          body,
          user: { login: 'native-bot' },
          created_at: '2026-10-21T10:00:00Z',
          updated_at: '2026-10-21T10:00:00Z',
        })),
      ),
      stderr: '',
    }
  }
  if (args.some((arg) => arg.includes('/comments?per_page=100&page=2'))) return { stdout: '[]', stderr: '' }
  const query = args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? ''
  if (query.includes('pullRequest(number:42)')) {
    const closing = closingIssues(origin, source)
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              number: 42,
              repository: { nameWithOwner: 'Acme/app' },
              labels: { nodes: [{ name: 'size:S' }] },
              closingIssuesReferences: { totalCount: closing.length, nodes: closing },
            },
          },
        },
      }),
      stderr: '',
    }
  }
  if (query.includes('search(query:')) {
    const existing = existingIssues(options, issue)
    return {
      stdout: JSON.stringify({ data: { search: { issueCount: existing.length, nodes: existing } } }),
      stderr: '',
    }
  }
  if (query.includes('issue(number:84)'))
    return { stdout: JSON.stringify({ data: { repository: { issue: renderIssue(issue) } } }), stderr: '' }
  throw new Error(`unexpected gh request ${query}`)
}

export function world(options: WorldOptions = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'omp-debt-filing-'))
  tmp = root
  const comments = options.unknownSource
    ? withUnknownSourceFinding(canonicalComments(options))
    : canonicalComments(options)
  const origin = options.origin ?? 'one'
  const source = sourceIssue(options, options.sourceSize ?? 'size:F-lite')
  const calls: World['calls'] = []
  const created: number[] = []
  let body = ''
  const issue: IssueState = {
    number: 84,
    title: '',
    body: '',
    author: 'native-bot',
    labels: [],
    type: null,
    parent: null,
    blockedBy: [],
  }
  const runner: ProcessRunner = async (file, args, runnerOptions) => {
    calls.push({ file, args, cwd: runnerOptions.cwd })
    if (file === 'bun') {
      const response = triageResponse(args, issue, origin, source, options, created)
      if (response.body !== null) body = response.body
      return response.result
    }
    return graphResponse(args, comments, origin, options, issue, source)
  }
  return { runner, calls, created, body: () => body }
}

export function filing(w: World, override: { causeIds?: readonly string[] } = {}) {
  return createTrustedDebtFiling(w.runner).file({
    receiptId: RECEIPT,
    target: TARGET,
    decisionId: 'decision-1',
    fixRequestId: 'fix-request-1',
    findingIds: ['finding-1'],
    causeIds: override.causeIds ?? ['cause-1'],
    evidence: { important: 'unknown', urgent: 'unknown', tooLarge: 'unknown', evidence: { provenance: 'caller-mode' } },
    retentionDiagnostics: ['baseline-blocking-member-required'],
    acceptedEvidencePolicyRef: null,
  })
}
