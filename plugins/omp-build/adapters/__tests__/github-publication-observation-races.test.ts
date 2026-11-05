import { expect, it } from 'vitest'
import { parseRecord } from '../../dist/contracts.js'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { reviewRoot } from '../../testing/record-builders.ts'
import { contribution } from '../../testing/record-decisions.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import type { GitHubOptions } from '../github/types.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { nativeComment, wire } from './github-workflow-support.ts'

it('publishes and validates read-back with the complete prewrite histories as refreshable scope seeds', async () => {
  const parsed = parseRecord(reviewRoot({ id: 'race-inventory' }))
  if (!parsed.ok || parsed.value.kind !== 'review-attempt') throw new Error('expected inventory')
  const root = parsed.value
  const record = contribution({ id: 'race-contribution', operationId: 'race-op', inventoryId: root.recordId })
  const primary = [nativeComment(1, wire(root))]
  const external: Array<{ id: number; body: string; user: { login: string }; created_at: string; updated_at: string }> =
    []
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
        external.push(nativeComment(200, 'unrelated external comment'))
        return JSON.stringify(posted)
      }
      if (endpoint.includes('/issues/42/comments')) return JSON.stringify(primary)
      if (endpoint.includes('/issues/44/comments')) return JSON.stringify(external)
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
    },
  }
  const initial = decodeHistory(await readGitHubHistory({ repository: root.repository, target: root.target }, options))
  const observed = decodeHistory(
    await readGitHubHistory({ repository: root.repository, target: `${root.repository}#44` }, options),
  )
  const result = await publishConfirmedWorkflowRecord(
    record,
    options,
    createPublicationContextResolver(options, null),
    [initial, observed],
  )
  expect(result.status, JSON.stringify(result)).toBe('confirmed')
  expect(posts).toBe(1)
})
