import type { Scope } from '../engine/record-values.ts'
import { nativeNumber } from './native-implementation-transport-graph.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

type Comment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

export function createNativeComments(repository: string, author: string, histories: NativeWorldFacts['histories']) {
  const comments = new Map<number, Comment[]>()
  let nextId = 1
  for (const history of histories) {
    const number = nativeNumber(history.source.scope)
    if (comments.has(number)) throw new Error('Ambiguous native history scope')
    comments.set(
      number,
      history.source.comments.map((comment) => {
        if (comment.author === null || comment.createdAt === null || comment.updatedAt === null)
          throw new Error('Native fixture comment metadata is incomplete')
        return {
          id: nextId++,
          body: comment.body,
          user: { login: comment.author },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        }
      }),
    )
  }
  function publish(args: readonly string[]): string {
    const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(args[3] ?? '')
    const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
    if (!match || match[1] !== repository || body === undefined) throw new Error('Undeclared publication')
    const list = comments.get(Number(match[2]))
    if (!list) throw new Error('Publication history was not declared')
    const date = '2026-10-27T12:00:00Z'
    const entry = { id: nextId++, body, user: { login: author }, created_at: date, updated_at: date }
    list.push(entry)
    return JSON.stringify(entry)
  }
  function response(args: readonly string[]): string | undefined {
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') return publish(args)
    const match = new RegExp(`^repos/${repository}/issues/(\\d+)/comments\\?per_page=100&page=(\\d+)$`).exec(
      args[1] ?? '',
    )
    if (args[0] === 'api' && match) {
      const list = comments.get(Number(match[1]))
      if (!list) throw new Error('Requested history was not declared')
      const offset = (Number(match[2]) - 1) * 100
      return JSON.stringify(list.slice(offset, offset + 100))
    }
    return undefined
  }
  function editComment(scope: Scope, nativeId: string, body: string, updatedAt: string, author?: string): void {
    const number = nativeNumber(scope)
    if (scope.repository !== repository || scope.target !== `${repository}#${number}` || !Number.isSafeInteger(number))
      throw new Error('Edited comment scope was not declared')
    const list = comments.get(number)
    const entry = list?.find((comment) => String(comment.id) === nativeId)
    if (!entry) throw new Error('Edited native comment was not declared')
    const updated = Date.parse(updatedAt)
    if (!Number.isFinite(updated) || updated <= Date.parse(entry.updated_at))
      throw new Error('Native comment edit must advance the observed timestamp')
    entry.body = body
    entry.updated_at = updatedAt
    if (author !== undefined) entry.user = { login: author }
  }
  return { has: (scope: Scope) => comments.has(nativeNumber(scope)), response, editComment }
}
