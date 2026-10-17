import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveIssueTypeId } from '../../shared/adapters/github-adapter'
import { EXTENDED_ISSUE_TYPES, ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { createIssue } from '../lib/create'
import { defaultInitDeps, initIssues } from '../lib/init'

// The real adapter runs; only the network edge (`fetch`) is stubbed. An org type
// with `isEnabled: false` is listed by the API but GitHub refuses to set an
// issue to it, so it must count as unavailable on every path (#626).
// Hoisted: GITHUB_REPO is read when the adapter's config module is first imported.
vi.hoisted(() => {
  process.env.GITHUB_REPO = 'Acme/app'
  process.env.GITHUB_TOKEN ||= 'not-used-fetch-is-stubbed'
})

const CANONICAL: string[] = [...ISSUE_TYPE_NAMES, ...EXTENDED_ISSUE_TYPES]

function orgTypes(disabled: string[]) {
  return CANONICAL.map((name) => ({
    id: `id-${name}`,
    name,
    color: 'GRAY',
    isEnabled: !disabled.includes(name),
  }))
}

describe('issue-triage > a disabled org issue type is unavailable (#626)', () => {
  let requests: { method: string; url: string }[]
  let logs: string[]
  let errors: string[]

  function stubOrg(disabled: string[]) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      requests.push({ method: init?.method ?? 'GET', url: target })
      const isTypeQuery = target.endsWith('/graphql') && String(init?.body).includes('issueTypes')
      const body = isTypeQuery
        ? { data: { organization: { issueTypes: { nodes: orgTypes(disabled) } } } }
        : { html_url: 'https://github.com/Acme/app/issues/1', number: 1, node_id: 'node-1' }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch)
  }

  function dryRunDeps() {
    return {
      ...defaultInitDeps('Acme/app'),
      listLabelNames: async () => [],
      listIssueLabelSets: async () => [],
      readContract: () => null,
    }
  }

  beforeEach(() => {
    requests = []
    logs = []
    errors = []
    vi.spyOn(console, 'log').mockImplementation((line) => {
      logs.push(String(line))
    })
    vi.spyOn(console, 'error').mockImplementation((line) => {
      errors.push(String(line))
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('resolveIssueTypeId rejects a disabled type and still resolves an enabled one', async () => {
    stubOrg(['fix'])
    await expect(resolveIssueTypeId('Acme', 'fix')).rejects.toThrow(/Issue type fix is disabled in org Acme/)
    await expect(resolveIssueTypeId('Acme', 'feat')).resolves.toBe('id-feat')
  })

  it('resolveIssueTypeId lists only enabled types as valid', async () => {
    stubOrg(['fix'])
    const message = await resolveIssueTypeId('Acme', 'no-such').catch((error: Error) => error.message)
    expect(message).toMatch(/^Unknown issue type: no-such\. Valid: /)
    expect(message).toContain('feat')
    expect(message).not.toMatch(/\bfix\b/)
  })

  it('init --dry-run names a disabled canonical type as missing', async () => {
    stubOrg(['fix'])
    await initIssues(['--dry-run', '--repo', 'Acme/app'], dryRunDeps())
    expect(logs).toContain('missing org issue types (1): fix')
    expect(logs).not.toContain('missing org issue types: (none)')
  })

  it('init --dry-run reports (none) when every canonical type is enabled', async () => {
    stubOrg([])
    await initIssues(['--dry-run', '--repo', 'Acme/app'], dryRunDeps())
    expect(logs).toContain('missing org issue types: (none)')
  })

  it('create --type fix against a disabled fix exits 1 before the issue is created', async () => {
    stubOrg(['fix'])
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`process.exit:${code}`)
    }) as never)
    await createIssue(['--title', 'Test', '--type', 'fix']).catch(() => {})
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(errors.join('\n')).toContain('Issue type fix is disabled in org Acme')
    // Only the org-types lookup left the process: no issue-create POST, no node-id GET, no mutation.
    expect(requests).toEqual([{ method: 'POST', url: 'https://api.github.com/graphql' }])
  })
})
