import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import {
  type CanonicalRecord,
  type DecodedHistory,
  decodeHistory,
  githubScope,
  type Json,
  readGitHubHistory,
  validateDecisionBindings,
  validateRetainedUnusableLabels,
} from '../dist/contracts.js'
import { triageCli, triageDirectory } from '../triage-runtime.ts'
import type { FixActionResult, FixTarget } from './fix'
import type { DebtEvidence } from './fix-domain'
import { withRoxabiGitHubPolicy } from './github-policy'

const execFileAsync = promisify(execFile)
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
type Size = 'S' | 'F-lite' | 'F-full'

type ProcessResult = { stdout: string; stderr: string; exitCode?: number }
export type ProcessRunner = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<ProcessResult>

export type DebtFilingInput = {
  receiptId: string
  target: FixTarget
  decisionId: string
  fixRequestId: string
  findingIds: readonly string[]
  causeIds: readonly string[]
  evidence: DebtEvidence
  retentionDiagnostics: readonly string[]
  acceptedEvidencePolicyRef: string | null
}

export type DebtFiling = {
  file(input: DebtFilingInput): Promise<FixActionResult<{ target: string; raw: Json }>>
}

type Ref = { repository: string; number: number }
type Source = { origin: string; issue: Ref | null; parent: Ref | null; size: Size }
type DebtIssue = {
  number: number
  title: string
  body: string
  author: string | null
  labels: string[]
  type: string | null
  parent: Ref | null
  blockedBy: Ref[]
}

function failure<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}

function defaultRunner(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return execFileAsync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
    .then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr), exitCode: 0 }))
    .catch((error: NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }) => ({
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      exitCode: typeof error.code === 'number' ? error.code : 1,
    }))
}

function ref(value: unknown): Ref | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const number = item.number
  const repository = item.repository
  const name =
    repository !== null && typeof repository === 'object' && !Array.isArray(repository)
      ? (repository as Record<string, unknown>).nameWithOwner
      : undefined
  return typeof number === 'number' &&
    Number.isSafeInteger(number) &&
    number > 0 &&
    typeof name === 'string' &&
    REPOSITORY.test(name)
    ? { repository: name, number }
    : null
}

function refText(value: Ref): string {
  return `${value.repository}#${value.number}`
}

function sameRef(left: Ref | null, right: Ref | null): boolean {
  return left !== null && right !== null && left.repository === right.repository && left.number === right.number
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('github-json-invalid')
  }
}

async function command(
  runner: ProcessRunner,
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runner(file, args, { cwd, env })
  if ((result.exitCode ?? 0) !== 0)
    throw new Error(`${file}-failed:${result.stderr || result.stdout || result.exitCode}`)
  return result.stdout
}

async function graph(runner: ProcessRunner, query: string, cwd: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return parseJson(await command(runner, 'gh', ['api', 'graphql', '-f', `query=${query}`], cwd, env))
}

function field(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const name of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !(name in current))
      return undefined
    current = (current as Record<string, unknown>)[name]
  }
  return current
}

function labels(value: unknown): string[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return null
  const names = nodes.map((node) =>
    node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>).name : null,
  )
  return names.every((name): name is string => typeof name === 'string') ? names : null
}

function sizeOf(value: unknown): Size | null {
  const found =
    labels(value)?.filter((name) => name === 'size:S' || name === 'size:F-lite' || name === 'size:F-full') ?? []
  return found.length === 1 ? (found[0].slice('size:'.length) as Size) : null
}

async function resolveSource(
  input: DebtFilingInput,
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Source> {
  const [owner, name] = input.target.repository.split('/')
  if (!owner || !name || !REPOSITORY.test(input.target.repository)) throw new Error('issue-triage-repository-invalid')
  if (input.target.kind === 'issue') {
    const data = await graph(
      runner,
      `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${input.target.number}){number repository{nameWithOwner} parent{number repository{nameWithOwner}} labels(first:100){nodes{name}}}}}`,
      cwd,
      env,
    )
    const issue = field(data, ['data', 'repository', 'issue'])
    const source = ref(issue)
    const size = sizeOf(field(issue, ['labels']))
    if (source === null || size === null) throw new Error('debt-source-issue-metadata-required')
    return { origin: `Issue ${refText(source)}`, issue: source, parent: ref(field(issue, ['parent'])), size }
  }

  const data = await graph(
    runner,
    `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){pullRequest(number:${input.target.number}){number repository{nameWithOwner} labels(first:100){nodes{name}} closingIssuesReferences(first:100){totalCount nodes{number repository{nameWithOwner} parent{number repository{nameWithOwner}} labels(first:100){nodes{name}}}}}}}`,
    cwd,
    env,
  )
  const pullRequest = field(data, ['data', 'repository', 'pullRequest'])
  const closing = field(pullRequest, ['closingIssuesReferences'])
  const nodes = field(closing, ['nodes'])
  const total = field(closing, ['totalCount'])
  if (!Array.isArray(nodes) || typeof total !== 'number' || total !== nodes.length || total > 100)
    throw new Error('debt-origin-issue-ambiguous')
  if (nodes.length === 0) {
    const size = sizeOf(field(pullRequest, ['labels']))
    if (size === null) throw new Error('debt-origin-size-required')
    return { origin: `PR ${input.target.target}`, issue: null, parent: null, size }
  }
  if (nodes.length !== 1) throw new Error('debt-origin-issue-ambiguous')
  const source = ref(nodes[0])
  const size = sizeOf(field(nodes[0], ['labels']))
  if (source === null || size === null) throw new Error('debt-source-issue-metadata-required')
  return {
    origin: `PR ${input.target.target}; source issue ${refText(source)}`,
    issue: source,
    parent: ref(field(nodes[0], ['parent'])),
    size,
  }
}

function selectedDecision(
  input: DebtFilingInput,
  history: DecodedHistory,
): Extract<CanonicalRecord, { kind: 'decision' }> | null {
  if (!history.source.complete || history.diagnostics.length > 0 || history.source.diagnostics.length > 0) return null
  const matches = history.operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.kind === 'decision' &&
      operation.recordId === input.decisionId &&
      operation.record?.kind === 'decision',
  )
  return matches.length === 1 && matches[0]?.record?.kind === 'decision' ? matches[0].record : null
}

function reviewBoundDecision(
  input: DebtFilingInput,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  records: ReadonlyMap<string, CanonicalRecord>,
): boolean {
  const request = records.get(input.fixRequestId)
  if (request?.kind !== 'fix-request') return false
  if (decision.payload.judgment.purpose !== 'review') return true
  const reviewId = request.payload.existingReviewId
  const review = reviewId === null ? null : records.get(reviewId)
  return (
    review?.kind === 'review' &&
    review.payload.decisionId === decision.recordId &&
    review.payload.candidateGitSHA === input.target.candidateGitSHA
  )
}

function obligationBody(
  input: DebtFilingInput,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  source: Source,
): { title: string; body: string } {
  if (!RECEIPT_ID.test(input.receiptId) || !RECEIPT_ID.test(input.decisionId))
    throw new Error('debt-receipt-or-decision-id-invalid')
  const ids = (values: readonly string[]) =>
    new Set(values).size === values.length && values.every((value) => RECEIPT_ID.test(value))
  if ((input.findingIds.length === 0 && input.causeIds.length === 0) || !ids(input.findingIds) || !ids(input.causeIds))
    throw new Error('debt-member-ids-invalid')
  if (
    input.retentionDiagnostics.length === 0 ||
    input.retentionDiagnostics.some((diagnostic) => diagnostic.trim().length === 0)
  )
    throw new Error('debt-retention-diagnostics-invalid')
  const judgment = decision.payload.judgment
  const findings = input.findingIds.map((id) => judgment.findings.find((finding) => finding.id === id) ?? null)
  const causes = input.causeIds.map((id) => judgment.causes.find((cause) => cause.id === id) ?? null)
  if (findings.some((finding) => finding === null) || causes.some((cause) => cause === null))
    throw new Error('debt-member-unconfirmed')
  const selectedFindings = findings.filter((finding): finding is NonNullable<typeof finding> => finding !== null)
  const selectedCauses = causes.filter((cause): cause is NonNullable<typeof cause> => cause !== null)
  const selectedFindingIds = new Set(input.findingIds)
  if (selectedCauses.some((cause) => cause.findingIds.some((id) => !selectedFindingIds.has(id))))
    throw new Error('debt-obligation-membership-invalid')
  const causedFindingIds = new Set(selectedCauses.flatMap((cause) => cause.findingIds))
  const detail = [
    ...selectedCauses.map((cause) =>
      [
        `### ${cause.id}: ${cause.title}`,
        '',
        '## Acceptance criteria',
        `- [ ] ${cause.fix}`,
        '',
        `- **Mechanism:** ${cause.mechanism}`,
        `- **Failure:** ${cause.failure}`,
        `- **Restored behavior:** ${cause.restored}`,
        `- **Paths:** ${cause.paths.join(', ')}`,
        `- **Proof:** ${cause.proof}`,
      ].join('\n'),
    ),
    ...selectedFindings
      .filter((finding) => !causedFindingIds.has(finding.id))
      .map((finding) =>
        [
          `### ${finding.id}: uncited correction obligation`,
          '',
          '## Acceptance criteria',
          `- [ ] Resolve confirmed finding \`${finding.id}\` while preserving its retained provenance.`,
          '',
          '- **Canonical correction cause:** none retained',
        ].join('\n'),
      ),
  ].join('\n\n')
  const findingText = selectedFindings
    .map((finding) =>
      [
        `### ${finding.id}`,
        `- **State:** ${finding.state}`,
        `- **Label:** ${finding.label ?? 'unlabelled'}`,
        `- **Impact:** ${finding.impactReason}`,
        ...('description' in finding ? [`- **Finding:** ${finding.description}`] : []),
        `- **Provenance:** ${finding.sourceFindingIds.join(', ')}`,
      ].join('\n'),
    )
    .join('\n\n')
  return {
    title: `Deferred correction obligations for ${input.target.target}`,
    body: [
      `<!-- omp-build-debt-receipt:${input.receiptId} -->`,
      `**Origin:** ${source.origin}`,
      '',
      '## Scope',
      `- decision: \`${decision.recordId}\``,
      `- fix request: \`${input.fixRequestId}\``,
      `- original contribution: \`${decision.payload.originalContributionId}\``,
      `- source contributions: ${judgment.sourceContributionIds.map((id) => `\`${id}\``).join(', ') || 'none'}`,
      `- policy: \`${judgment.policy.version}\``,
      `- receipt: \`${input.receiptId}\``,
      '',
      '## Retained correction obligations',
      detail,
      '',
      '## Confirmed findings',
      findingText,

      '## Retention diagnostics',
      ...input.retentionDiagnostics.map((diagnostic) => `- \`${diagnostic}\``),
      '',
      '## Filing evidence',
      `\`\`\`json\n${JSON.stringify(input.evidence.evidence)}\n\`\`\``,
    ].join('\n'),
  }
}

function issue(value: unknown): DebtIssue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const number = item.number
  const title = item.title
  const body = item.body
  const author = item.author
  const issueType = item.issueType
  const blockedBy = item.blockedBy
  const authorLogin =
    author !== null && typeof author === 'object' && !Array.isArray(author)
      ? (author as Record<string, unknown>).login
      : null
  const type =
    issueType !== null && typeof issueType === 'object' && !Array.isArray(issueType)
      ? (issueType as Record<string, unknown>).name
      : null
  const dependencies =
    blockedBy !== null && typeof blockedBy === 'object' && !Array.isArray(blockedBy)
      ? (blockedBy as Record<string, unknown>).nodes
      : null
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof title !== 'string' ||
    typeof body !== 'string' ||
    (authorLogin !== null && typeof authorLogin !== 'string') ||
    (type !== null && typeof type !== 'string') ||
    !Array.isArray(dependencies)
  )
    return null
  const refs = dependencies.map(ref)
  const issueLabels = labels(item.labels)
  return refs.some((entry) => entry === null) || issueLabels === null
    ? null
    : {
        number,
        title,
        body,
        author: authorLogin,
        labels: issueLabels,
        type,
        parent: ref(item.parent),
        blockedBy: refs as Ref[],
      }
}

async function readIssue(
  repository: string,
  number: number,
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<DebtIssue | null> {
  const [owner, name] = repository.split('/')
  if (!owner || !name) return null
  const data = await graph(
    runner,
    `query{repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){issue(number:${number}){number title body author{login} labels(first:100){nodes{name}} issueType{name} parent{number repository{nameWithOwner}} blockedBy(first:100){nodes{number repository{nameWithOwner}}}}}}`,
    cwd,
    env,
  )
  const result = issue(field(data, ['data', 'repository', 'issue']))
  return result?.number === number ? result : null
}

function mismatch(actual: DebtIssue, expected: { title: string; body: string; author: string }): string[] {
  const result: string[] = []
  if (actual.title !== expected.title) result.push('title')
  if (actual.body !== expected.body) result.push('body')
  if (actual.author !== expected.author) result.push('author')
  return result
}

function relationshipConflict(actual: DebtIssue, source: Source): string[] {
  const conflicts: string[] = []
  if (
    source.parent === null ? actual.parent !== null : actual.parent !== null && !sameRef(actual.parent, source.parent)
  )
    conflicts.push('parent')
  if (
    source.issue === null
      ? actual.blockedBy.length > 0
      : actual.blockedBy.some((entry) => !sameRef(entry, source.issue))
  )
    conflicts.push('blocked-by')
  return conflicts
}

function missingMetadata(actual: DebtIssue, source: Source): string[] {
  const missing: string[] = []
  if (actual.type?.toLowerCase() !== 'fix') missing.push('--type', 'fix')
  const sizes = actual.labels.filter(
    (label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full',
  )
  if (sizes.length !== 1 || sizes[0] !== `size:${source.size}`) missing.push('--size', source.size)
  if (source.parent !== null && actual.parent === null) missing.push('--parent', refText(source.parent))
  if (source.issue !== null && actual.blockedBy.length === 0) missing.push('--blocked-by', refText(source.issue))
  return missing
}

async function expectedAuthor(
  input: DebtFilingInput,
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ author: string; decision: Extract<CanonicalRecord, { kind: 'decision' }> }> {
  const options = withRoxabiGitHubPolicy({
    cwd,
    gh: async (cwd, args) => command(runner, 'gh', args, cwd, env),
  })
  const history = decodeHistory(
    await readGitHubHistory(githubScope(input.target.repository, input.target.number), options),
  )
  const decision = selectedDecision(input, history)
  if (decision === null) throw new Error('debt-decision-unconfirmed')
  const bindings = validateDecisionBindings(decision, history)
  if (!bindings.admissible)
    throw new Error(`debt-decision-unbound:${bindings.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`)
  const retainedLabels = validateRetainedUnusableLabels(decision, bindings)
  if (!retainedLabels.ok)
    throw new Error(
      `debt-retained-label-unbound:${retainedLabels.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  if (!reviewBoundDecision(input, decision, bindings.records)) throw new Error('debt-review-binding-unconfirmed')
  if (
    decision.payload.judgment.policy.version === 'evidence-v1' &&
    decision.payload.judgment.policy.acceptanceRef !== input.acceptedEvidencePolicyRef
  ) {
    throw new Error('debt-decision-evidence-policy-unaccepted')
  }
  return { author: history.source.expectedAuthor, decision }
}

function discoveryQuery(repository: string, marker: string): string {
  return `query{search(query:${JSON.stringify(`repo:${repository} in:body ${marker}`)},type:ISSUE,first:100){issueCount nodes{...on Issue{number title body author{login} labels(first:100){nodes{name}} issueType{name} parent{number repository{nameWithOwner}} blockedBy(first:100){nodes{number repository{nameWithOwner}}}}}}}`
}

function discoveredIssues(data: unknown): DebtIssue[] | null {
  const search = field(data, ['data', 'search'])
  const count = field(search, ['issueCount'])
  const nodes = field(search, ['nodes'])
  if (!Array.isArray(nodes) || typeof count !== 'number' || count !== nodes.length || count > 100) return null
  const entries = nodes.map(issue)
  return entries.some((entry) => entry === null) ? null : (entries as DebtIssue[])
}

/**
 * The sole debt issue writer. It resolves the receipt's canonical decision through
 * the common GitHub codec, then treats search as discovery only and accepts a native
 * issue only after a complete identity/body/relationship read-back.
 */
export function createTrustedDebtFiling(runner: ProcessRunner = defaultRunner): DebtFiling {
  const triage = existsSync(triageCli) ? triageCli : null
  return {
    async file(input) {
      if (triage === null) return failure('issue-triage-unavailable')
      if (!REPOSITORY.test(input.target.repository)) return failure('issue-triage-repository-invalid')
      const env = { ...process.env, GITHUB_REPO: input.target.repository }
      const triageCwd = triageDirectory
      const files = mkdtempSync(join(tmpdir(), 'omp-build-fix-debt-'))
      try {
        const source = await resolveSource(input, runner, triageCwd, env)
        const canonical = await expectedAuthor(input, runner, triageCwd, env)
        const content = obligationBody(input, canonical.decision, source)
        const marker = `omp-build-debt-receipt:${input.receiptId}`
        const discovery = discoveredIssues(
          await graph(runner, discoveryQuery(input.target.repository, marker), triageCwd, env),
        )
        if (discovery === null) return failure('issue-triage-existing-receipt-uncertain')
        if (discovery.length > 1) return failure('issue-triage-existing-receipt-ambiguous')
        let number: number | null = discovery[0]?.number ?? null
        if (number !== null) {
          const found = discovery[0]
          if (found === undefined || mismatch(found, { ...content, author: canonical.author }).length > 0)
            return failure('issue-triage-existing-receipt-untrusted')
        } else {
          const titleFile = join(files, 'title.txt')
          const bodyFile = join(files, 'body.md')
          writeFileSync(titleFile, content.title)
          writeFileSync(bodyFile, content.body)
          const args = [
            '--no-env-file',
            triage,
            'create',
            '--title-file',
            titleFile,
            '--body-file',
            bodyFile,
            '--type',
            'fix',
            '--size',
            source.size,
          ]
          if (source.parent !== null) args.push('--parent', refText(source.parent))
          if (source.issue !== null) args.push('--blocked-by', refText(source.issue))
          const result = await runner('bun', args, { cwd: triageCwd, env })
          const created = /(?:^|\n)Created #([1-9][0-9]*)\b/m.exec(result.stdout)?.[1]
          if (created === undefined) return failure('issue-triage-create-unconfirmed', result.stderr || result.stdout)
          number = Number(created)
        }
        const firstRead = await readIssue(input.target.repository, number, runner, triageCwd, env)
        if (firstRead === null) return failure('issue-triage-readback-unavailable')
        const immutable = mismatch(firstRead, { ...content, author: canonical.author })
        if (immutable.length > 0) return failure(`issue-triage-readback-mismatch:${immutable.join(',')}`)
        const conflict = relationshipConflict(firstRead, source)
        if (conflict.length > 0) return failure(`issue-triage-readback-mismatch:${conflict.join(',')}`)
        const missing = missingMetadata(firstRead, source)
        if (missing.length > 0) {
          const repair = await runner('bun', ['--no-env-file', triage, 'set', String(number), ...missing], {
            cwd: triageCwd,
            env,
          })
          if ((repair.exitCode ?? 0) !== 0) return failure('issue-triage-repair-failed', repair.stderr || repair.stdout)
          const repaired = await readIssue(input.target.repository, number, runner, triageCwd, env)
          if (repaired === null) return failure('issue-triage-readback-unavailable')
          const repairedImmutable = mismatch(repaired, { ...content, author: canonical.author })
          const repairedConflict = relationshipConflict(repaired, source)
          const repairedMissing = missingMetadata(repaired, source)
          if (repairedImmutable.length > 0 || repairedConflict.length > 0 || repairedMissing.length > 0)
            return failure(
              `issue-triage-readback-mismatch:${[...repairedImmutable, ...repairedConflict, ...repairedMissing].join(',')}`,
            )
        }
        return {
          ok: true,
          value: {
            target: `${input.target.repository}#${number}`,
            raw: { receiptId: input.receiptId, source: source.origin, size: source.size },
          },
        }
      } catch (error) {
        return failure(`issue-triage-file-failed:${error instanceof Error ? error.message : String(error)}`)
      } finally {
        rmSync(files, { recursive: true, force: true })
      }
    },
  }
}
