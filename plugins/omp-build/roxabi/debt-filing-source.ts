import type { DebtFilingInput, ProcessRunner, Ref, Size, Source } from './debt-filing-contract.ts'
import { REPOSITORY } from './debt-filing-contract.ts'

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

export async function graph(
  runner: ProcessRunner,
  query: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  return parseJson(await command(runner, 'gh', ['api', 'graphql', '-f', `query=${query}`], cwd, env))
}

export function field(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const name of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !(name in current))
      return undefined
    current = (current as Record<string, unknown>)[name]
  }
  return current
}

export function labels(value: unknown): string[] | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const nodes = (value as Record<string, unknown>).nodes
  if (!Array.isArray(nodes)) return null
  const names = nodes.map((node) =>
    node !== null && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>).name : null,
  )
  return names.every((name): name is string => typeof name === 'string') ? names : null
}

export function sizeOf(value: unknown): Size | null {
  const found =
    labels(value)?.filter((name) => name === 'size:S' || name === 'size:F-lite' || name === 'size:F-full') ?? []
  return found.length === 1 ? (found[0].slice('size:'.length) as Size) : null
}

export async function resolveSource(
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
