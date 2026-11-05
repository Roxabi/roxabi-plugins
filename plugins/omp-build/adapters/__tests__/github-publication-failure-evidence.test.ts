import { expect, it } from 'vitest'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import type { GitHubOptions } from '../github/types.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { nativeComment } from './github-workflow-support.ts'

const record = {
  repository: 'acme/app',
  target: 'acme/app#42',
  version: 1 as const,
  recordId: 'failure-evidence',
  runId: 'failure-run',
  operationId: 'failure-op',
  inputs: [] as string[],
  kind: 'epic-event' as const,
  payload: { outcome: 'verified' },
}

it.each(['actor', 'authorization', 'first-read'] as const)(
  'reports no native history when publication fails before its first observation: %s',
  async (mode) => {
    const options: GitHubOptions = {
      cwd: '/fixture',
      ...(mode === 'actor' ? {} : { readAuthor: 'automation' }),
      writerLogin: mode === 'authorization' ? 'stranger' : 'automation',
      gh: async () => {
        throw new Error('native read unavailable')
      },
    }
    const result = await publishConfirmedWorkflowRecord(
      record,
      options,
      createPublicationContextResolver(options, null),
    )
    expect(result.status).toBe(mode === 'authorization' ? 'refused' : 'uncertain')
    if (result.status === 'confirmed') throw new Error('failure unexpectedly confirmed')
    expect(result.history).toBeNull()
    expect(result.diagnostics.length).toBeGreaterThan(0)
  },
)

it('retains the actual prewrite history when read-back fails after a successful native POST', async () => {
  let posts = 0
  const baseline = nativeComment(1, 'existing native comment')
  const options: GitHubOptions = {
    cwd: '/fixture',
    readAuthor: 'automation',
    writerLogin: 'automation',
    gh: async (_cwd, args) => {
      if (args.includes('POST')) {
        const body = args.find((arg) => arg.startsWith('body='))
        if (!body) throw new Error('missing post body')
        posts += 1
        return JSON.stringify(nativeComment(2, body.slice(5)))
      }
      if (args.some((arg) => arg.includes('/comments'))) {
        if (posts > 0) throw new Error('readback unavailable')
        return JSON.stringify([baseline])
      }
      throw new Error(`unexpected request: ${args.join(' ')}`)
    },
  }
  const result = await publishConfirmedWorkflowRecord(record, options, createPublicationContextResolver(options, null))
  expect(result.status).toBe('uncertain')
  if (result.status === 'confirmed') throw new Error('unreadable readback unexpectedly confirmed')
  expect(posts).toBe(1)
  expect(result.history?.source).toMatchObject({
    scope: { repository: 'acme/app', target: 'acme/app#42' },
    complete: true,
    comments: [expect.objectContaining({ nativeId: '1', body: baseline.body, author: 'automation' })],
  })
  expect(result.history?.operations).toEqual([])
})
