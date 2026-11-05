import { expect, it } from 'vitest'
import { actionInputDigest, canonicalValueDigest, recordsOf } from '../../dist/contracts.js'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { causeOriginalHistory } from '../../testing/cause-input-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { GitHubOptions } from '../github/types.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { nativeComment } from './github-workflow-support.ts'

it.each(['valid', 'mandate-disappears'] as const)(
  'revalidates cited mandate after a committed POST loses its acknowledgement: %s',
  async (mode) => {
    const original = causeOriginalHistory()
    const mandate = recordsOf(original).find((record) => record.kind === 'mandate')
    if (mandate?.kind !== 'mandate') throw new Error('expected mandate')
    const pr = { repository: 'acme/app', target: 'acme/app#46' }
    const fixtures = roxabiWorkflowFixtures()
    const binding = fixtures.workflowBinding(pr, mandate, 'feat/42-save', 'main')
    const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'lost-ack', label: 'issue' })
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
    const candidate = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'lost-ack', label: 'issue', inputs })
    const issueHistory = fixtures.historyFrom([mandate], 'automation')
    const primary = fixtures
      .framedBodies([binding, candidate.root], 'automation', [issueHistory])
      .map((body, index) => nativeComment(index + 1, body))
    const external = issueHistory.source.comments.map((comment, index) => nativeComment(1000 + index, comment.body))
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
          primary.push(nativeComment(100 + posts, body.slice(5)))
          if (mode === 'mandate-disappears') external.length = 0
          throw new Error('connection lost after GitHub committed the comment')
        }
        if (endpoint.includes('/issues/46/comments')) return JSON.stringify(primary)
        if (endpoint.includes('/issues/42/comments')) return JSON.stringify(external)
        throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
      },
    }
    const result = await publishConfirmedWorkflowRecord(
      candidate.spec,
      options,
      createPublicationContextResolver(options, null),
      [issueHistory],
    )
    expect(result.status, JSON.stringify(result)).toBe(mode === 'valid' ? 'confirmed' : 'uncertain')
    expect(posts).toBe(1)
  },
)
