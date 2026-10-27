import type { DebtIssue, ProcessRunner, Ref, Size, Source } from '../../roxabi/debt-filing-contract.ts'
import { REPOSITORY } from '../../roxabi/debt-filing-contract.ts'
import type { DebtFilingInput } from '../../roxabi/debt-filing-port.ts'

export function ref(value: unknown): Ref | null {
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

export function refText(value: Ref): string {
  return `${value.repository}#${value.number}`
}

export function sameRef(left: Ref | null, right: Ref | null): boolean {
  return left !== null && right !== null && left.repository === right.repository && left.number === right.number
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('github-json-invalid')
  }
}

export async function command(
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

export async function resolveNativeDebtSource(
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

function debtIssue(value: unknown): DebtIssue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
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
    typeof item.number !== 'number' ||
    !Number.isSafeInteger(item.number) ||
    item.number < 1 ||
    typeof item.title !== 'string' ||
    typeof item.body !== 'string' ||
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
        number: item.number,
        title: item.title,
        body: item.body,
        author: authorLogin,
        labels: issueLabels,
        type,
        parent: ref(item.parent),
        blockedBy: refs as Ref[],
      }
}

export async function readNativeDebtIssue(
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
  const result = debtIssue(field(data, ['data', 'repository', 'issue']))
  return result?.number === number ? result : null
}

function discoveryQuery(repository: string, marker: string): string {
  return `query{search(query:${JSON.stringify(`repo:${repository} in:body ${marker}`)},type:ISSUE,first:100){issueCount nodes{...on Issue{number title body author{login} labels(first:100){nodes{name}} issueType{name} parent{number repository{nameWithOwner}} blockedBy(first:100){nodes{number repository{nameWithOwner}}}}}}}`
}

export async function discoverNativeDebtIssues(
  repository: string,
  marker: string,
  runner: ProcessRunner,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<DebtIssue[] | null> {
  const search = field(await graph(runner, discoveryQuery(repository, marker), cwd, env), ['data', 'search'])
  const count = field(search, ['issueCount'])
  const nodes = field(search, ['nodes'])
  if (!Array.isArray(nodes) || typeof count !== 'number' || count !== nodes.length || count > 100) return null
  const entries = nodes.map(debtIssue)
  return entries.some((entry) => entry === null) ? null : (entries as DebtIssue[])
}
