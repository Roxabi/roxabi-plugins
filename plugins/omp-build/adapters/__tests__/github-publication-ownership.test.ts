import { expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { githubScope } from '../github/transport.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'

it('does not POST if publication ownership is revoked during the fresh history read', async () => {
  const record = {
    repository: 'acme/app',
    target: 'acme/app#42',
    version: 1 as const,
    recordId: 'event-revoked',
    runId: 'run-1',
    operationId: 'op-revoked',
    inputs: [] as string[],
    kind: 'epic-event' as const,
    payload: { outcome: 'verified' },
  }
  const empty: DecodedHistory = {
    source: {
      scope: githubScope('acme/app', 42),
      expectedAuthor: 'automation',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: [],
    diagnostics: [],
  }
  let owned = true
  let posts = 0
  const published = await publishConfirmedWorkflowRecord(
    record,
    empty,
    {
      cwd: '/fixture',
      readAuthor: 'automation',
      writeAuthor: 'automation',
      writerLogin: 'automation',
      canPublish: () => owned,
      gh: async (_cwd, args) => {
        if (args.includes('POST')) {
          posts += 1
          throw new Error('must not post')
        }
        if (String(args[1] ?? '').includes('/comments')) {
          await Promise.resolve()
          owned = false
          return '[]'
        }
        throw new Error(`unexpected gh request: ${args.join(' ')}`)
      },
    },
    null,
  )
  expect(posts).toBe(0)
  expect(published.status).toBe('uncertain')
  if (published.status === 'confirmed') throw new Error('revoked publication cannot be confirmed')
  expect(published.diagnostics.map((entry) => entry.code)).toContain('publication-ownership-revoked')
})
