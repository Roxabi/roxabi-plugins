import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { type CanonicalRecord, encodeRecord } from '../dist/contracts.js'
import { contribution, reviewGraph, TEST_PROJECTION_CONFIG } from '../testing/records'
import { createTrustedDebtFiling, type ProcessRunner } from './debt-filing'

const RECEIPT = 'receipt-1'
const TARGET = {
  repository: 'Acme/app',
  target: 'Acme/app#42',
  number: 42,
  kind: 'pull-request' as const,
  state: 'open' as const,
  candidateGitSHA: 'a'.repeat(40),
}
let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

type ReviewJudgment = Extract<
  Extract<CanonicalRecord, { kind: 'decision' }>['payload']['judgment'],
  { purpose: 'review' }
>
type ReviewAttemptRecord = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function canonicalUnusableComments(): string[] {
  const graph = reviewGraph({ prefix: 'debt', head: TARGET.candidateGitSHA })
  const sourceJudgment = graph.decision.payload.judgment
  const judgment: Extract<CanonicalRecord, { kind: 'decision' }>['payload']['judgment'] = {
    purpose: 'correction',
    policy: sourceJudgment.policy,
    sourceContributionIds: ['debt-spec', 'debt-panel'],
    findings: [
      {
        id: 'finding-1',
        label: 'issue',
        impactReason: 'The saved region is wrong.',
        state: 'unusable',
        sourceFindingIds: ['debt-panel:f0'],
      },
    ],
    causes: [
      {
        id: 'cause-1',
        title: 'Persist the selected region',
        mechanism: 'The save path uses the stale region field.',
        fix: 'Save the selected region field.',
        failure: 'Saving eu-west persists us-east.',
        restored: 'Saving preserves the selected region.',
        paths: ['src/widget.ts'],
        proof: 'pnpm test widget',
        findingIds: ['finding-1'],
      },
    ],
  }
  const decision: CanonicalRecord = {
    ...graph.decision,
    recordId: 'decision-1',
    operationId: 'operation-decision-1',
    inputs: ['debt-decision-source', 'debt-spec', 'debt-panel'],
    repository: TARGET.repository,
    target: TARGET.target,
    payload: { originalContributionId: 'debt-decision-source', judgment },
  }
  const synthesis: CanonicalRecord = {
    ...graph.synthesisContribution,
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      ...graph.synthesisContribution.payload,
      structured: judgment,
      rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({ ...attempt, data: judgment })),
    },
  }
  const requestContribution: CanonicalRecord = {
    ...contribution({ id: 'fix-request-contribution', inventoryId: null, content: 'operator-request' }),
    repository: TARGET.repository,
    target: TARGET.target,
  }
  const request: CanonicalRecord = {
    version: 1,
    recordId: 'fix-request-1',
    runId: 'run-2026-10-21',
    operationId: 'operation-fix-request-1',
    inputs: [requestContribution.recordId],
    kind: 'fix-request',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      requestContributionId: requestContribution.recordId,
      existingReviewId: null,
      scope: TARGET.target,
      landing: false,
    },
  }
  const root: ReviewAttemptRecord = {
    version: 1,
    recordId: 'debt-root',
    runId: 'run-2026-10-21',
    operationId: 'op-debt-root',
    inputs: [request.recordId],
    kind: 'review-attempt',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      rootAttemptId: 'debt-root',
      candidateGitSHA: TARGET.candidateGitSHA,
      input: graph.root.payload.input,
      slots: graph.root.payload.slots,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy: sourceJudgment.policy,
    },
  }
  const correctionSynthesis: ReviewAttemptRecord = {
    version: 1,
    recordId: 'debt-synthesis',
    runId: 'run-2026-10-21',
    operationId: 'op-debt-synthesis',
    inputs: [root.recordId],
    kind: 'review-attempt',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      rootAttemptId: root.recordId,
      candidateGitSHA: TARGET.candidateGitSHA,
      input: graph.synthesis.payload.input,
      slots: graph.synthesis.payload.slots,
      stage: 'synthesis',
      purpose: 'correction',
      policy: sourceJudgment.policy,
    },
  }
  const records: CanonicalRecord[] = [
    requestContribution,
    request,
    root,
    { ...graph.spec, repository: TARGET.repository, target: TARGET.target },
    { ...graph.panel, repository: TARGET.repository, target: TARGET.target },
    correctionSynthesis,
    synthesis,
    decision,
  ]
  return encodeCanonicalComments(records)
}

function encodeCanonicalComments(records: readonly CanonicalRecord[]): string[] {
  const history = (comments: readonly string[]) => ({
    scope: { repository: TARGET.repository, target: TARGET.target },
    expectedAuthor: 'native-bot',
    stopAuthor: null,
    complete: true,
    comments: comments.map((body, index) => ({
      locator: `comment-${index + 1}`,
      nativeId: String(index + 1),
      body,
      author: 'native-bot',
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: null,
    })),
    diagnostics: [],
  })
  const bodies: string[] = []
  for (const record of records) {
    const encoded = encodeRecord(record, history(bodies), TEST_PROJECTION_CONFIG)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((item) => item.code).join(','))
    bodies.push(...encoded.value)
  }
  return bodies
}
function canonicalComments(options: { unusable?: boolean } = {}): string[] {
  if (options.unusable) return canonicalUnusableComments()
  const graph = reviewGraph({ prefix: 'debt', head: TARGET.candidateGitSHA })
  const sourceJudgment = graph.decision.payload.judgment
  if (sourceJudgment.purpose !== 'review') throw new Error('review-fixture-purpose-missing')
  const findings: ReviewJudgment['findings'] = options.unusable
    ? [
        {
          id: 'finding-1',
          label: 'issue',
          impactReason: 'The saved region is wrong.',
          state: 'unusable',
          sourceFindingIds: ['debt-panel:f0'] as [string],
        },
      ]
    : [
        {
          id: 'finding-1',
          label: 'issue',
          impactReason: 'The saved region is wrong.',
          state: 'usable',
          sourceFindingIds: ['debt-panel:f0'],
          description: 'Save the selected region rather than the stale region.',
        },
      ]
  const judgment: ReviewJudgment = {
    ...sourceJudgment,
    findings,
    causes: [
      {
        id: 'cause-1',
        title: 'Persist the selected region',
        mechanism: 'The save path uses the stale region field.',
        fix: 'Save the selected region field.',
        failure: 'Saving eu-west persists us-east.',
        restored: 'Saving preserves the selected region.',
        paths: ['src/widget.ts'],
        proof: 'pnpm test widget',
        findingIds: ['finding-1'],
      },
    ],
  }
  const decision = {
    ...graph.decision,
    recordId: 'decision-1',
    operationId: 'operation-decision-1',
    inputs: ['debt-decision-source', 'debt-spec', 'debt-panel'],
    payload: {
      ...graph.decision.payload,
      originalContributionId: 'debt-decision-source',
      judgment,
    },
  } satisfies CanonicalRecord
  const synthesis = {
    ...graph.synthesisContribution,
    payload: {
      ...graph.synthesisContribution.payload,
      structured: decision.payload.judgment,
      rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({
        ...attempt,
        data: decision.payload.judgment,
      })),
    },
  } satisfies CanonicalRecord
  const review = {
    ...graph.review,
    inputs: graph.review.inputs.map((id) => (id === graph.decision.recordId ? decision.recordId : id)),
    payload: { ...graph.review.payload, decisionId: decision.recordId },
  } satisfies CanonicalRecord
  const requestContribution = contribution({
    id: 'fix-request-contribution',
    inventoryId: null,
    content: 'operator-request',
  })
  const request: CanonicalRecord = {
    version: 1,
    recordId: 'fix-request-1',
    runId: 'run-2026-10-21',
    operationId: 'operation-fix-request-1',
    inputs: [requestContribution.recordId, review.recordId],
    kind: 'fix-request',
    repository: TARGET.repository,
    target: TARGET.target,
    payload: {
      requestContributionId: requestContribution.recordId,
      existingReviewId: review.recordId,
      scope: TARGET.target,
      landing: false,
    },
  }
  const records = graph.records
    .map((record) =>
      record.recordId === graph.decision.recordId
        ? decision
        : record.recordId === graph.synthesisContribution.recordId
          ? synthesis
          : record.recordId === graph.review.recordId
            ? review
            : record,
    )
    .concat(requestContribution, request)
    .map((record) => ({ ...record, repository: TARGET.repository, target: TARGET.target }))
  const history = (comments: readonly string[]) => ({
    scope: { repository: TARGET.repository, target: TARGET.target },
    expectedAuthor: 'native-bot',
    stopAuthor: null,
    complete: true,
    comments: comments.map((body, index) => ({
      locator: `comment-${index + 1}`,
      nativeId: String(index + 1),
      body,
      author: 'native-bot',
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: null,
    })),
    diagnostics: [],
  })
  const bodies: string[] = []
  for (const record of records) {
    const encoded = encodeRecord(record, history(bodies), TEST_PROJECTION_CONFIG)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((item) => item.code).join(','))
    bodies.push(...encoded.value)
  }
  return bodies
}

function withUnknownSourceFinding(bodies: readonly string[]): string[] {
  return bodies.map((body) => {
    if (!body.includes('id=decision-1 ')) return body
    return body.replace(
      /^(<!-- omp-build-record v=1 kind=decision id=decision-1 operationId=operation-decision-1 part=1\/1 data=)([^ ]+)( -->)/,
      (_, prefix: string, encoded: string, suffix: string) => {
        const record = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as CanonicalRecord
        if (record.kind !== 'decision') throw new Error('decision-fixture-missing')
        const first = record.payload.judgment.findings[0]
        if (first === undefined) throw new Error('decision-fixture-finding-missing')
        first.sourceFindingIds = ['missing-source:f0']
        return `${prefix}${Buffer.from(JSON.stringify(record)).toString('base64url')}${suffix}`
      },
    )
  })
}

type IssueState = {
  number: number
  title: string
  body: string
  author: string | null
  labels: string[]
  type: string | null
  parent: { number: number; repository: { nameWithOwner: string } } | null
  blockedBy: { number: number; repository: { nameWithOwner: string } }[]
}

type World = {
  runner: ProcessRunner
  calls: { file: string; args: string[]; cwd: string }[]
  created: number[]
  body: () => string
}

function world(
  options: {
    origin?: 'one' | 'none' | 'many'
    parent?: 'same' | 'foreign' | 'none'
    existing?: 'none' | 'malicious' | 'duplicate'
    partial?: boolean
    sourceSize?: string
    unusable?: boolean
    capitalizedType?: boolean
    unknownSource?: boolean
  } = {},
): World {
  const root = mkdtempSync(join(tmpdir(), 'omp-debt-filing-'))
  tmp = root
  const comments = options.unknownSource
    ? withUnknownSourceFinding(canonicalComments(options))
    : canonicalComments(options)
  const origin = options.origin ?? 'one'
  const sourceSize = options.sourceSize ?? 'size:F-lite'
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
  const sourceIssue = {
    number: 70,
    repository: { nameWithOwner: 'Acme/app' },
    parent:
      options.parent === 'none'
        ? null
        : { number: 7, repository: { nameWithOwner: options.parent === 'foreign' ? 'Acme/planning' : 'Acme/app' } },
    labels: { nodes: [{ name: sourceSize }] },
  }
  const renderIssue = (state: IssueState) => ({
    ...state,
    author: state.author === null ? null : { login: state.author },
    labels: { nodes: state.labels.map((name) => ({ name })) },
    issueType: state.type === null ? null : { name: state.type },
    blockedBy: { nodes: state.blockedBy },
  })
  const runner: ProcessRunner = async (file, args, runnerOptions) => {
    calls.push({ file, args, cwd: runnerOptions.cwd })
    if (file === 'bun') {
      if (args.includes('create')) {
        created.push(issue.number)
        body = readFileSync(args[args.indexOf('--body-file') + 1] ?? '', 'utf8')
        issue.title = readFileSync(args[args.indexOf('--title-file') + 1] ?? '', 'utf8').trim()
        issue.body = body
        const size = args[args.indexOf('--size') + 1] ?? ''
        if (!options.partial) {
          issue.type = options.capitalizedType ? 'Fix' : 'fix'
          issue.labels = [`size:${size}`]
          if (origin === 'one') {
            issue.parent = sourceIssue.parent
            issue.blockedBy = [sourceIssue]
          }
        }
        return { stdout: 'Created #84\n', stderr: '', exitCode: options.partial ? 1 : 0 }
      }
      const size = args[args.indexOf('--size') + 1] ?? ''
      issue.type = 'fix'
      issue.labels = [`size:${size}`]
      if (origin === 'one') {
        issue.parent = sourceIssue.parent
        issue.blockedBy = [sourceIssue]
      }
      return { stdout: 'Type=fix #84\n', stderr: '', exitCode: 0 }
    }
    if (args.join(' ') === 'api user --jq .login') return { stdout: 'native-bot\n', stderr: '' }
    if (args.some((arg) => arg.includes('/comments?per_page=100&page=1'))) {
      return {
        stdout: JSON.stringify(
          comments.map((body, index) => ({
            id: index + 1,
            body,
            user: { login: 'native-bot' },
            created_at: '2026-10-21T10:00:00Z',
            updated_at: null,
          })),
        ),
        stderr: '',
      }
    }
    if (args.some((arg) => arg.includes('/comments?per_page=100&page=2'))) return { stdout: '[]', stderr: '' }
    const query = args.find((arg) => arg.startsWith('query='))?.slice('query='.length) ?? ''
    if (query.includes('pullRequest(number:42)')) {
      const closing =
        origin === 'none' ? [] : origin === 'many' ? [sourceIssue, { ...sourceIssue, number: 71 }] : [sourceIssue]
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
      const malicious =
        options.existing === 'malicious'
          ? [
              {
                ...renderIssue(issue),
                number: 66,
                body: `<!-- omp-build-debt-receipt:${RECEIPT} --> forged`,
                author: { login: 'attacker' },
              },
            ]
          : options.existing === 'duplicate'
            ? [renderIssue(issue), { ...renderIssue(issue), number: 67 }]
            : []
      return {
        stdout: JSON.stringify({ data: { search: { issueCount: malicious.length, nodes: malicious } } }),
        stderr: '',
      }
    }
    if (query.includes('issue(number:84)'))
      return { stdout: JSON.stringify({ data: { repository: { issue: renderIssue(issue) } } }), stderr: '' }
    throw new Error(`unexpected gh request ${query}`)
  }
  return { runner, calls, created, body: () => body }
}

function filing(w: World, override: { causeIds?: readonly string[] } = {}) {
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

describe('trusted debt filing', () => {
  it('files a PR follow-up beside its closing issue parent and blocks on that issue', async () => {
    const w = world()
    const result = await filing(w)

    expect(result).toMatchObject({ ok: true, value: { target: 'Acme/app#84' } })
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).toEqual(
      expect.arrayContaining([
        '--no-env-file',
        '--type',
        'fix',
        '--size',
        'F-lite',
        '--parent',
        'Acme/app#7',
        '--blocked-by',
        'Acme/app#70',
      ]),
    )
    expect(w.body()).toContain('## Acceptance criteria')
    expect(w.body()).toContain('The save path uses the stale region field.')
    expect(w.body()).toContain('Save the selected region rather than the stale region.')
    expect(w.body()).toContain('## Retention diagnostics')
    expect(w.body()).toContain('baseline-blocking-member-required')
  })

  it('keeps a foreign source parent coordinate when filing a sibling follow-up', async () => {
    const w = world({ parent: 'foreign' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))?.args).toEqual(
      expect.arrayContaining(['--parent', 'Acme/planning#7', '--blocked-by', 'Acme/app#70']),
    )
  })

  it('files beside a top-level source issue without a parent relation', async () => {
    const w = world({ parent: 'none' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).not.toContain('--parent')
    expect(create?.args).toEqual(expect.arrayContaining(['--blocked-by', 'Acme/app#70']))
  })

  it('accepts the native Fix type spelling after readback', async () => {
    const w = world({ capitalizedType: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.calls.filter((call) => call.file === 'bun' && call.args.includes('set'))).toHaveLength(0)
  })

  it('files from the exact confirmed review-purpose decision without reclassification', async () => {
    const w = world()
    const result = await filing(w)

    expect(result).toMatchObject({ ok: true, value: { target: 'Acme/app#84' } })
    expect(w.body()).toContain('- decision: `decision-1`')
  })

  it('files a canonically bound retained unusable finding without reclassifying it', async () => {
    const w = world({ unusable: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.created).toEqual([84])
    expect(w.body()).toContain('- **Label:** issue')
  })

  it('files an uncited canonical finding without inventing a correction cause', async () => {
    const w = world()
    const result = await filing(w, { causeIds: [] })

    expect(result.ok).toBe(true)
    expect(w.body()).toContain('### finding-1: uncited correction obligation')
    expect(w.body()).toContain('**Canonical correction cause:** none retained')
  })

  it('refuses an unknown canonical source finding before creating', async () => {
    const w = world({ unknownSource: true })
    const result = await filing(w)

    expect(result).toMatchObject({ ok: false, diagnostics: [expect.stringContaining('unknown-reference')] })
    expect(w.created).toEqual([])
  })

  it('omits issue relationships but retains PR origin when the PR closes no issue', async () => {
    const w = world({ origin: 'none' })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    const create = w.calls.find((call) => call.file === 'bun' && call.args.includes('create'))
    expect(create?.args).not.toContain('--parent')
    expect(create?.args).not.toContain('--blocked-by')
    expect(w.body()).toContain('**Origin:** PR Acme/app#42')
  })

  it('refuses malicious receipt discoveries instead of treating a marker as proof', async () => {
    const w = world({ existing: 'malicious' })
    const result = await filing(w)

    expect(result).toEqual({ ok: false, diagnostics: ['issue-triage-existing-receipt-untrusted'] })
    expect(w.created).toEqual([])
  })

  it('refuses ambiguous receipt discovery before creating', async () => {
    const w = world({ existing: 'duplicate' })
    const result = await filing(w)

    expect(result).toEqual({ ok: false, diagnostics: ['issue-triage-existing-receipt-ambiguous'] })
    expect(w.created).toEqual([])
  })

  it('refuses ambiguous PR origin before creating', async () => {
    const w = world({ origin: 'many' })
    const result = await filing(w)

    expect(result).toMatchObject({ ok: false, diagnostics: ['issue-triage-file-failed:debt-origin-issue-ambiguous'] })
    expect(w.created).toEqual([])
  })

  it('repairs a partial create through set and never issues a second create', async () => {
    const w = world({ partial: true })
    const result = await filing(w)

    expect(result.ok).toBe(true)
    expect(w.created).toEqual([84])
    expect(w.calls.filter((call) => call.file === 'bun' && call.args.includes('create'))).toHaveLength(1)
    expect(w.calls.find((call) => call.file === 'bun' && call.args.includes('set'))?.args).toEqual(
      expect.arrayContaining([
        '--type',
        'fix',
        '--size',
        'F-lite',
        '--parent',
        'Acme/app#7',
        '--blocked-by',
        'Acme/app#70',
      ]),
    )
  })

  it('refuses before writing when the source has no mandatory size metadata', async () => {
    const w = world({ sourceSize: 'not-a-size' })
    const result = await filing(w)

    expect(result).toMatchObject({
      ok: false,
      diagnostics: ['issue-triage-file-failed:debt-source-issue-metadata-required'],
    })
    expect(w.created).toEqual([])
  })
})
