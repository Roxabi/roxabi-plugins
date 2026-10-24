import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHubOptions } from '../dist/contracts.js'
import * as contracts from '../dist/contracts.js'
import { history } from '../testing/record-history.ts'
import type { FixIdentity, FixTarget, NativePort, PublishBinding, ReviewAuthority } from './fix-contract.ts'
import { bindFixMandate, runDefaultFix } from './fix-entry-default.ts'
import type { DefaultFixEntry } from './fix-entry-input.ts'
import { loadFixOnlyDraft } from './fix-mandate-authority.ts'

afterEach(() => {
  vi.restoreAllMocks()
})
describe('default fix feature mandate binding', () => {
  it('refuses a required Feature mandate when no bound mandate can be reused before publishing a fix-only mandate', async () => {
    let published = 0
    const input: DefaultFixEntry = {
      cwd: '/worktree',
      requiredFeatureMandate: {
        scope: { repository: 'Acme/app', target: 'Acme/app#42' },
        recordId: 'feature-mandate',
        kind: 'mandate',
      },
      native: {} as NativePort,
      workflow: {} as ReviewAuthority,
      gh: async () => {
        throw new Error('must not read fix-only mandate inputs')
      },
    }
    const identity: FixIdentity = {
      runId: 'run-1',
      operationId: 'operation-1',
      nextRecordId: () => 'unused',
    }
    const target: FixTarget = {
      repository: 'Acme/app',
      target: 'Acme/app#42',
      number: 42,
      kind: 'issue',
      state: 'open',
      candidateGitSHA: 'a'.repeat(40),
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

    const result = await bindFixMandate(
      input,
      identity,
      target,
      {} as GitHubOptions,
      publishBinding,
      'correct the review finding',
      async () => history([]),
      async () => {
        published += 1
        return { ok: true, value: undefined }
      },
    )

    expect(result).toEqual({ ok: false, diagnostics: ['feature-mandate-required'] })
    expect(published).toBe(0)
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
        gh: async () => {
          reads += 1
          throw new Error('target resolution reached')
        },
      },
      { runId: 'run-1', operationId: 'operation-1', nextRecordId: () => 'unused' },
      { signal: new AbortController().signal, onBatch: () => undefined, onStarted: () => undefined },
    )

    expect(result).toMatchObject({ ok: false, diagnostics: ['fix-repository-unreadable:target resolution reached'] })
    expect(reads).toBe(1)
  })
  it('returns the typed product-version failure when package metadata is unreadable', async () => {
    vi.spyOn(contracts, 'shippedProductVersion').mockImplementation(() => {
      throw new Error('package metadata is unreadable')
    })

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
      work: { reference: 'Acme/app#42', body: 'correct the finding', lastEditedAt: '2026-10-01T00:00:00Z' },
      parent: null,
      antecedent: null,
    })

    expect(result).toEqual({ ok: false, diagnostics: ['fix-product-version-unreadable'] })
  })
})
