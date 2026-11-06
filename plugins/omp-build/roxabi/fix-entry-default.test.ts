import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubOptions } from '../dist/contracts.js'
import * as contracts from '../dist/contracts.js'
import { fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import { history } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import type { FixTarget, NativePort, PublishBinding, ReviewAuthority } from './fix-contract.ts'
import { bindFixMandate, runDefaultFix } from './fix-entry-default.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { loadFixOnlyDraft } from './fix-mandate-authority.ts'
import type { UwReadPort } from './uw-contract.ts'

afterEach(() => {
  vi.restoreAllMocks()
})
const unavailableUw: UwReadPort = {
  readUw: async () => {
    throw new Error('unexpected UW read')
  },
}

describe('default fix feature mandate binding', () => {
  it('refuses a required Feature mandate when no bound mandate can be reused', async () => {
    const input: DefaultFixEntry = {
      cwd: '/worktree',
      requiredFeatureMandate: {
        scope: { repository: 'Acme/app', target: 'Acme/app#42' },
        recordId: 'feature-mandate',
        kind: 'mandate',
      },
      native: {} as NativePort,
      workflow: {} as ReviewAuthority,
      uw: unavailableUw,
      operations: fixtureUwOperations(),
      gh: async () => {
        throw new Error('must not read fix-only mandate inputs')
      },
    }
    const target: FixTarget = {
      repository: 'Acme/app',
      target: 'Acme/app#42',
      number: 42,
      kind: 'issue',
      state: 'open',
      candidateGitSHA: 'a'.repeat(40),
      baseGitSHA: 'a'.repeat(40),
    }
    const publishBinding: PublishBinding = {
      pushUrl: 'https://github.com/Acme/app.git',
      publicationRepository: 'Acme/app',
      localBranch: 'fix/auth',
      destinationRef: 'refs/heads/fix/auth',
      localHead: 'a'.repeat(40),
      expectedRemoteSHA: 'a'.repeat(40),
      defaultBranch: 'main',
      observed: {},
    }

    const emptyPage = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
    const github: GitHubOptions = {
      cwd: '/worktree',
      readAuthor: 'operator',
      stopAuthor: 'github-actions[bot]',
      gh: async (_cwd, args) => {
        if (args[0] === 'api' && args[1] === 'graphql') {
          if (!args.some((arg) => arg.includes('blockedBy') && arg.includes('subIssues')))
            throw new Error(`unexpected GraphQL request: ${args.join(' ')}`)
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  number: 42,
                  repository: { nameWithOwner: 'Acme/app' },
                  title: 'Correct the finding',
                  body: '',
                  updatedAt: '2026-10-21T10:00:00Z',
                  state: 'OPEN',
                  stateReason: null,
                  parent: null,
                  labels: emptyPage,
                  subIssues: emptyPage,
                  blockedBy: emptyPage,
                },
              },
            },
          })
        }
        if (args[0] === 'api' && args[1] === 'repos/Acme/app/issues/42/comments?per_page=100&page=1') return '[]'
        throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
      },
    }
    const scope = { repository: target.repository, target: target.target }
    const readHistory = async () => contracts.decodeHistory(await contracts.readGitHubHistory(scope, github))
    expect((await readHistory()).operations).toEqual(history([]).operations)
    const baseline = await bindFixMandate(
      { ...input, requiredFeatureMandate: undefined },
      target,
      github,
      publishBinding,
      readHistory,
    )
    expect(baseline).toEqual({ ok: false, diagnostics: ['fix-own-uw-required'] })
    const result = await bindFixMandate(input, target, github, publishBinding, readHistory)

    expect(result).toEqual({ ok: false, diagnostics: ['feature-mandate-required'] })
  })

  it('allows a raw operator request to reach target resolution when args are empty', async () => {
    let reads = 0
    const result = await runDefaultFix(
      {
        cwd: '/worktree',
        args: '',
        rawOperatorRequest: { request: 'correct the finding' },
        native: {} as NativePort,
        workflow: {} as ReviewAuthority,
        uw: unavailableUw,
        operations: fixtureUwOperations(),
        gh: async () => {
          reads += 1
          throw new Error('target resolution reached')
        },
      },
      { runId: 'run-1', operationId: 'operation-1', nextRecordId: () => 'unused' },
      {
        signal: new AbortController().signal,
        uw: fixtureUwOperations(),
        onBatch: () => undefined,
        onStarted: () => undefined,
      },
    )

    expect(result).toMatchObject({ ok: false, diagnostics: ['fix-repository-unreadable:target resolution reached'] })
    expect(reads).toBe(1)
  })
  it('returns the typed product-version failure when package metadata is unreadable', async () => {
    vi.spyOn(contracts, 'shippedProductVersion').mockImplementation(() => {
      throw new Error('package metadata is unreadable')
    })
    const mandate = roxabiWorkflowFixtures().fixOnlyMandate({ repository: 'Acme/app', target: 'Acme/app#42' })
    if (mandate.kind !== 'mandate') throw new Error('fixture-mandate-missing')

    const result = await loadFixOnlyDraft({
      cwd: '/worktree',
      commit: 'a'.repeat(40),
      git: async () => ({ code: 0, stdout: '', stderr: '' }),
      scope: { repository: 'Acme/app', target: 'Acme/app#42' },
      recordId: 'fix-mandate',
      runId: 'run-1',
      operationId: 'operation-1',
      branch: 'fix/42',
      base: 'main',
      candidateGitSHA: 'a'.repeat(40),
      ownSpec: mandate.payload.ownSpec,
      tier: mandate.payload.tier,
      children: mandate.payload.children,
      inheritedOwnSpecRefs: mandate.payload.inheritedOwnSpecRefs,
      coverage: mandate.payload.coverage,
      parent: null,
      antecedent: null,
    })

    expect(result).toEqual({ ok: false, diagnostics: ['fix-product-version-unreadable'] })
  })
})
