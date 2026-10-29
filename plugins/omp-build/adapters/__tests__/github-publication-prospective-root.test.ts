import { expect, it } from 'vitest'
import { parseRecord } from '../../engine/record-construction.ts'
import { reviewRoot } from '../../testing/record-builders.ts'
import { contribution } from '../../testing/record-decisions.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { nativeComment, wire } from './github-workflow-support.ts'

it.each(['clean', 'foreign', 'expected'] as const)(
  'publishes a new native contribution only with an eligible reservation: %s',
  async (mode) => {
    const parsed = parseRecord(reviewRoot({ id: 'run-inventory-1' }))
    if (!parsed.ok || parsed.value.kind !== 'review-attempt') throw new Error('expected canonical inventory')
    const root = parsed.value
    const record = contribution({
      id: 'run-contribution-3',
      operationId: 'op-contribution-3',
      inventoryId: root.recordId,
    })
    const partial =
      '<!-- omp-build-record v=1 kind=contribution id=run-contribution-3 operationId=foreign-reservation part=1/2 data=e30 -->'
    const comments = [nativeComment(1, wire(root))]
    if (mode !== 'clean') {
      comments.push({
        ...nativeComment(2, partial),
        user: { login: mode === 'foreign' ? 'stranger' : 'automation' },
      })
    }
    const empty = decodeHistory({
      scope: { repository: root.repository, target: root.target },
      expectedAuthor: 'automation',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    })
    let posts = 0
    const result = await publishConfirmedWorkflowRecord(
      record,
      empty,
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        writerLogin: 'automation',
        gh: async (_cwd, args) => {
          if (args.includes('POST')) {
            const body = args.find((arg) => arg.startsWith('body='))
            if (body === undefined) throw new Error('missing fake publication body')
            posts += 1
            const posted = nativeComment(100 + posts, body.slice(5))
            comments.push(posted)
            return JSON.stringify(posted)
          }
          if (String(args[1] ?? '').includes('/comments')) return JSON.stringify(comments)
          throw new Error(`unexpected gh args: ${args.join(' ')}`)
        },
      },
      null,
    )
    if (mode === 'expected') {
      expect(result).toMatchObject({ status: 'refused' })
      expect(posts).toBe(0)
    } else {
      expect(result).toMatchObject({ status: 'confirmed', operation: { recordId: record.recordId } })
      expect(posts).toBe(1)
    }
  },
)
