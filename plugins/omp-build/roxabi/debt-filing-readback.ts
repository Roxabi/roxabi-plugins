import type { CanonicalRecord } from '../dist/contracts.js'
import {
  decodeHistory,
  githubScope,
  readGitHubHistory,
  validateDecisionBindings,
  validateRetainedUnusableLabels,
} from '../dist/contracts.js'
import type { DebtIssue, ProcessRunner, Ref, Source } from './debt-filing-contract.ts'
import { reviewBoundDecision, selectedDecision } from './debt-filing-decision.ts'
import type { DebtFilingInput } from './debt-filing-port.ts'
import { command, field, graph, labels, ref, refText, sameRef } from './debt-filing-source.ts'
import { withRoxabiGitHubPolicy } from './github-policy'

export function issue(value: unknown): DebtIssue | null {
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

export async function readIssue(
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

export function mismatch(actual: DebtIssue, expected: { title: string; body: string; author: string }): string[] {
  const result: string[] = []
  if (actual.title !== expected.title) result.push('title')
  if (actual.body !== expected.body) result.push('body')
  if (actual.author !== expected.author) result.push('author')
  return result
}

export function relationshipConflict(actual: DebtIssue, source: Source): string[] {
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

export function missingMetadata(actual: DebtIssue, source: Source): string[] {
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

export async function expectedAuthor(
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

export function discoveryQuery(repository: string, marker: string): string {
  return `query{search(query:${JSON.stringify(`repo:${repository} in:body ${marker}`)},type:ISSUE,first:100){issueCount nodes{...on Issue{number title body author{login} labels(first:100){nodes{name}} issueType{name} parent{number repository{nameWithOwner}} blockedBy(first:100){nodes{number repository{nameWithOwner}}}}}}}`
}

export function discoveredIssues(data: unknown): DebtIssue[] | null {
  const search = field(data, ['data', 'search'])
  const count = field(search, ['issueCount'])
  const nodes = field(search, ['nodes'])
  if (!Array.isArray(nodes) || typeof count !== 'number' || count !== nodes.length || count > 100) return null
  const entries = nodes.map(issue)
  return entries.some((entry) => entry === null) ? null : (entries as DebtIssue[])
}
