import { describe, expect, it } from 'vitest'
import type { GitHubOptions } from '../dist/contracts.js'
import { history } from '../testing/record-history.ts'
import type { FixIdentity, FixTarget, NativePort, PublishBinding, ReviewAuthority } from './fix-contract.ts'
import { bindFixMandate, type DefaultFixEntry } from './fix-entry-default.ts'

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
})
