import { afterEach, describe, expect, it, vi } from 'vitest'
import * as contracts from '../dist/contracts.js'
import { fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import type { NativePort, ReviewAuthority } from './fix-contract.ts'
import { runDefaultFix } from './fix-entry-default.ts'
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
