import { describe, expect, it } from 'vitest'
import { githubScope } from '../github/transport.ts'
import { readIssueParentAssociation, readLinkedIssueAssociation } from '../github-workflow/associations.ts'
import { resolveNativeScope, resolveNativeTarget } from '../github-workflow/native-facts.ts'
import { BASE_TIP, closingGraphql, fakeGh, HEAD, prView } from './github-workflow-support.ts'

describe('native target facts', () => {
  it('resolves an existing issue without creating a ticket', async () => {
    const resolved = await resolveNativeTarget(7, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) =>
          args[0] === 'repo' && args[1] === 'view' ? JSON.stringify({ nameWithOwner: 'acme/app' }) : undefined,
        (args) =>
          args[0] === 'api' && args[1] === 'repos/acme/app/issues/7'
            ? JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: 'exact spec body' })
            : undefined,
      ]),
    })
    expect(resolved).toEqual({
      status: 'issue',
      scope: githubScope('acme/app', 7),
      issue: {
        repository: 'acme/app',
        number: 7,
        state: 'OPEN',
        author: 'operator',
        body: 'exact spec body',
        isPullRequest: false,
      },
    })
  })

  it('resolves a recorded scope in its declared repository without cwd fallback', async () => {
    const calls: string[][] = []
    const resolved = await resolveNativeScope(
      { repository: 'acme/parent', target: 'acme/parent#7' },
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: async (_cwd, args) => {
          calls.push(args)
          if (args[0] === 'api' && args[1] === 'repos/acme/parent/issues/7')
            return JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: 'parent spec' })
          throw new Error(`Unexpected gh call: ${args.join(' ')}`)
        },
      },
    )
    expect(calls).toEqual([['api', 'repos/acme/parent/issues/7']])
    expect(resolved).toMatchObject({ status: 'issue', scope: githubScope('acme/parent', 7) })
  })

  it('refuses a recorded scope whose target does not match its repository', async () => {
    const resolved = await resolveNativeScope(
      { repository: 'acme/parent', target: 'acme/other#7' },
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: async () => {
          throw new Error('GitHub must not be read for a mismatched scope')
        },
      },
    )
    expect(resolved).toMatchObject({
      status: 'refused',
      diagnostics: [expect.objectContaining({ code: 'invalid-scope' })],
    })
  })

  it('resolves a pull request with head and base facts', async () => {
    const resolved = await resolveNativeTarget(
      '#42',
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: fakeGh([
          (args) =>
            args[0] === 'api' && args[1] === 'repos/acme/app/issues/42'
              ? JSON.stringify({
                  number: 42,
                  state: 'open',
                  user: { login: 'operator' },
                  body: 'pr issue body',
                  pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/42' },
                })
              : undefined,
          (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        ]),
      },
      'acme/app',
    )
    expect(resolved).toMatchObject({
      status: 'pull-request',
      scope: githubScope('acme/app', 42),
      pullRequest: {
        repository: 'acme/app',
        pr: 42,
        head: HEAD,
        base: 'main',
        baseTip: BASE_TIP,
        branch: 'feat/7-work',
      },
    })
  })
})

describe('native issue associations', () => {
  it('reports linked, none, and ambiguous closing-issue associations explicitly', async () => {
    const options = {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }]) : undefined),
      ]),
    }
    await expect(readLinkedIssueAssociation('acme/app', 42, options)).resolves.toEqual({
      status: 'linked',
      scope: githubScope('acme/app', 7),
      number: 7,
    })

    const none = await readLinkedIssueAssociation('acme/app', 42, {
      ...options,
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([]) : undefined),
      ]),
    })
    expect(none).toEqual({ status: 'none' })

    const ambiguous = await readLinkedIssueAssociation('acme/app', 42, {
      ...options,
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }, { number: 8 }]) : undefined),
      ]),
    })
    expect(ambiguous).toMatchObject({ status: 'ambiguous' })
  })

  it('refuses incomplete closing-issue pagination instead of inventing absence', async () => {
    const result = await readLinkedIssueAssociation('acme/app', 42, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }], 2) : undefined),
      ]),
    })
    expect(result).toMatchObject({ status: 'incomplete' })
  })

  it('reads a parent issue association for child mandate binding', async () => {
    const linked = await readIssueParentAssociation('acme/app', 7, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) =>
          args.includes('graphql')
            ? JSON.stringify({
                data: {
                  repository: {
                    issue: {
                      number: 7,
                      parent: { number: 3, repository: { nameWithOwner: 'acme/app' } },
                    },
                  },
                },
              })
            : undefined,
      ]),
    })
    expect(linked).toEqual({ status: 'linked', scope: githubScope('acme/app', 3), number: 3 })
  })
})
