import { readNativeIssueState } from '../adapters/github-native/issue-state.ts'
import type { FixTarget, TargetResolver } from './fix-contract.ts'
import { execFileAsync, type Gh, object } from './fix-entry-target-core.ts'

export function parseInvocation(
  args: string | undefined,
  reference: string | undefined,
): { reference: string | undefined; request: string; malformed: boolean } {
  if (reference !== undefined) return { reference, request: args?.trim() ?? '', malformed: false }
  const text = args?.trim() ?? ''
  const [first, ...rest] = text.split(/\s+/)
  if (!first) return { reference: undefined, request: '', malformed: false }
  if (/^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?[1-9][0-9]*$/.test(first))
    return { reference: first, request: rest.join(' '), malformed: false }
  return { reference: undefined, request: text, malformed: first.startsWith('#') || first.includes('#') }
}

export function targetFromPr(repository: string, number: number, details: unknown): FixTarget | null {
  const item = object(details)
  if (
    item === null ||
    item.state !== 'OPEN' ||
    typeof item.headRefOid !== 'string' ||
    !/^[0-9a-f]{40}$/.test(item.headRefOid)
  )
    return null
  return {
    repository,
    target: `${repository}#${number}`,
    number,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: item.headRefOid,
  }
}

export async function targetFromIssue(
  cwd: string,
  repository: string,
  number: number,
  details: unknown,
): Promise<FixTarget | null> {
  const item = object(details)
  if (item === null || item.state !== 'OPEN') return null
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })
    const candidateGitSHA = String(stdout).trim()
    if (!/^[0-9a-f]{40}$/.test(candidateGitSHA)) return null
    return { repository, target: `${repository}#${number}`, number, kind: 'issue', state: 'open', candidateGitSHA }
  } catch {
    return null
  }
}

export function createResolver(cwd: string, gh: Gh, repository: string): TargetResolver {
  const explicit = async (reference: string): Promise<FixTarget | null> => {
    const trimmed = reference.trim()
    const foreignRepository = /^([^#]+)#/.exec(trimmed)?.[1]
    if (foreignRepository !== undefined && foreignRepository !== repository) return null
    const match = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?([1-9][0-9]*)$/.exec(trimmed)
    if (!match) return null
    const number = Number(match[1])
    try {
      return targetFromPr(
        repository,
        number,
        JSON.parse(await gh(cwd, ['pr', 'view', String(number), '--json', 'state,headRefOid'])),
      )
    } catch {
      try {
        return await targetFromIssue(cwd, repository, number, await readNativeIssueState(cwd, gh, number))
      } catch {
        return null
      }
    }
  }
  return {
    resolveExplicit: explicit,
    resolveContext: async () => {
      try {
        const value = object(JSON.parse(await gh(cwd, ['pr', 'view', '--json', 'number,state,headRefOid'])))
        return value !== null && typeof value.number === 'number' ? targetFromPr(repository, value.number, value) : null
      } catch {
        return null
      }
    },
  }
}
