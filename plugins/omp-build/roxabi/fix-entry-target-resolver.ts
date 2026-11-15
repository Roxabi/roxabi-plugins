import { readNativeIssueState } from '../adapters/github-native/issue-state.ts'
import type { FixTarget, TargetResolver } from './fix-contract.ts'
import { type IssueAliasReadPort, resolveIssueAlias } from './fix-entry-issue-alias.ts'
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
    baseGitSHA: typeof item.baseGitSHA === 'string' && /^[0-9a-f]{40}$/.test(item.baseGitSHA) ? item.baseGitSHA : null,
  }
}

export function createResolver(cwd: string, gh: Gh, repository: string, readPort: IssueAliasReadPort): TargetResolver {
  const pullTarget = async (number: number, value: unknown): Promise<FixTarget | null> => {
    const details = object(value)
    if (details === null || typeof details.baseRefName !== 'string' || details.baseRefName.length === 0) return null
    const observed = await execFileAsync('git', ['rev-parse', '--verify', `origin/${details.baseRefName}`], {
      cwd,
      encoding: 'utf8',
    }).catch(() => null)
    if (observed === null) return null
    const baseGitSHA = String(observed.stdout).trim()
    if (!/^[0-9a-f]{40}$/.test(baseGitSHA)) return null
    return targetFromPr(repository, number, { ...details, baseGitSHA })
  }
  const aliasTarget = async (number: number) => {
    try {
      const details = JSON.parse(
        await gh(cwd, ['pr', 'view', String(number), '--json', 'state,headRefOid,baseRefName']),
      )
      if (object(details)?.state === 'MERGED') return { ok: false as const, diagnostics: ['fix-issue-alias-merged'] }
      if (object(details)?.state === 'CLOSED') return { ok: false as const, diagnostics: ['fix-issue-alias-closed'] }
      const target = await pullTarget(number, details)
      return target === null
        ? { ok: false as const, diagnostics: ['fix-issue-alias-no-pr'] }
        : { ok: true as const, value: target }
    } catch {
      return { ok: false as const, diagnostics: ['fix-issue-alias-no-pr'] }
    }
  }
  const issueTarget = async (number: number) => {
    let issue: unknown
    try {
      issue = await readNativeIssueState(cwd, gh, number)
    } catch {
      return { ok: true as const, value: null }
    }
    if (object(issue)?.state === 'CLOSED') return { ok: false as const, diagnostics: ['fix-issue-alias-closed'] }
    if (object(issue)?.state !== 'OPEN') return { ok: true as const, value: null }
    const alias = await resolveIssueAlias(cwd, gh, repository, number, readPort)
    if (!alias.ok) return alias
    return aliasTarget(alias.value)
  }
  const explicit: TargetResolver['resolveExplicit'] = async (reference) => {
    const trimmed = reference.trim()
    const foreignRepository = /^([^#]+)#/.exec(trimmed)?.[1]
    if (foreignRepository !== undefined && foreignRepository !== repository) return { ok: true, value: null }
    const match = /^(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#?([1-9][0-9]*)$/.exec(trimmed)
    if (!match) return { ok: true, value: null }
    const number = Number(match[1])
    try {
      const details = JSON.parse(
        await gh(cwd, ['pr', 'view', String(number), '--json', 'state,headRefOid,baseRefName']),
      )
      return { ok: true, value: await pullTarget(number, details) }
    } catch {
      return issueTarget(number)
    }
  }
  return {
    resolveExplicit: explicit,
    resolveContext: async () => {
      try {
        const value = object(JSON.parse(await gh(cwd, ['pr', 'view', '--json', 'number,state,headRefOid,baseRefName'])))
        return value !== null && typeof value.number === 'number' ? await pullTarget(value.number, value) : null
      } catch {
        return null
      }
    },
  }
}
