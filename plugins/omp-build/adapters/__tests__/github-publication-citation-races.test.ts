import { expect, it } from 'vitest'
import { actionInputDigest, canonicalValueDigest, recordsOf } from '../../dist/contracts.js'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { causeOriginalHistory } from '../../testing/cause-input-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { nativeComment } from './github-workflow-support.ts'

type NativeComment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

it.each(['before-write', 'foreign', 'incomplete', 'after-write', 'idempotent'] as const)(
  'does not confirm a review contribution when its cited mandate is unavailable: %s',
  async (mode) => {
    const original = causeOriginalHistory()
    const mandate = recordsOf(original).find((record) => record.kind === 'mandate')
    if (mandate?.kind !== 'mandate') throw new Error('expected mandate')
    const pr = { repository: 'acme/app', target: 'acme/app#46' }
    const fixtures = roxabiWorkflowFixtures()
    const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
    const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'race', label: 'issue' })
    const manifest = {
      ...base.inputs.manifest,
      acceptedSources: [
        {
          source: 'record' as const,
          record: { scope: original.source.scope, kind: 'mandate' as const, recordId: mandate.recordId },
          selector: '/payload',
          digest: canonicalValueDigest(mandate.payload),
        },
      ],
    }
    const inputs = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
    const candidate = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'race', label: 'issue', inputs })
    const issueHistory = fixtures.historyFrom([mandate], 'automation')
    const primary = fixtures
      .framedBodies([binding, candidate.root], 'automation', [issueHistory])
      .map((body, index) => nativeComment(index + 1, body))
    const external: NativeComment[] = issueHistory.source.comments.map((comment, index) =>
      nativeComment(1000 + index, comment.body),
    )
    let posts = 0
    const options: GitHubOptions = {
      cwd: '/fixture',
      readAuthor: 'automation',
      writerLogin: 'automation',
      gh: async (_cwd, args) => {
        const catalogue = fixtureCatalogueGhResponse(args)
        if (catalogue !== null) return catalogue
        const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
        if (args.includes('POST')) {
          const body = args.find((arg) => arg.startsWith('body='))
          if (body === undefined) throw new Error('missing publication body')
          posts += 1
          const posted = nativeComment(100 + posts, body.slice(5))
          primary.push(posted)
          if (mode === 'after-write') external.length = 0
          return JSON.stringify(posted)
        }
        if (endpoint.includes('/issues/46/comments')) return JSON.stringify(primary)
        if (endpoint.includes('/issues/42/comments')) return JSON.stringify(external)
        throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
      },
    }
    const initial = decodeHistory(await readGitHubHistory(pr, options))
    const externalSeed = decodeHistory(await readGitHubHistory(original.source.scope, options))
    expect(
      initial.operations.some(
        (operation) => operation.recordId === binding.recordId && operation.status === 'complete',
      ),
    ).toBe(true)
    expect(
      initial.operations.some(
        (operation) => operation.recordId === candidate.root.recordId && operation.status === 'complete',
      ),
    ).toBe(true)
    expect(
      externalSeed.operations.some(
        (operation) =>
          operation.recordId === mandate.recordId &&
          operation.status === 'complete' &&
          operation.authority !== 'foreign',
      ),
    ).toBe(true)
    const publish = () =>
      publishConfirmedWorkflowRecord(candidate.spec, options, createPublicationContextResolver(options, null), [
        initial,
        externalSeed,
      ])
    if (mode === 'before-write') external.length = 0
    if (mode === 'foreign')
      external.splice(0, external.length, ...external.map((comment) => ({ ...comment, user: { login: 'stranger' } })))
    if (mode === 'incomplete')
      external.splice(
        0,
        external.length,
        nativeComment(
          2,
          `<!-- omp-build-record v=1 kind=mandate id=${mandate.recordId} operationId=${mandate.operationId} part=1/2 data=e30 -->`,
        ),
      )
    if (mode === 'idempotent') {
      expect((await publish()).status).toBe('confirmed')
      expect(posts).toBe(1)
      external.length = 0
    }
    const result = await publish()
    expect(result.status, JSON.stringify(result)).toBe(mode === 'after-write' ? 'uncertain' : 'refused')
    expect(posts).toBe(mode === 'after-write' || mode === 'idempotent' ? 1 : 0)
  },
)
