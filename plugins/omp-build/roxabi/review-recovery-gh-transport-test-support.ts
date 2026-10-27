import { fakeGh } from '../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../adapters/github/types.ts'

type NativeComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}
type RecoveryGhTransportInput = {
  comments: Map<number, NativeComment[]>
  append: (number: number, body: string, author?: string) => NativeComment
  postResponseAuthor?: string
  postStoredAuthor?: string
}

const repository = 'acme/app'

function issueCommentsEndpoint(args: string[]): string | undefined {
  return args[0] === 'api' ? args.find((value) => value.startsWith(`repos/${repository}/issues/`)) : undefined
}

function readComments(endpoint: string, comments: Map<number, NativeComment[]>): string | undefined {
  const read = new RegExp(`^repos/${repository}/issues/(\\d+)/comments\\?per_page=100&page=(\\d+)$`).exec(endpoint)
  if (read === null) return undefined
  const entries = comments.get(Number(read[1])) ?? []
  return JSON.stringify(Number(read[2]) === 1 ? entries : [])
}

function postComment(input: RecoveryGhTransportInput, args: string[], endpoint: string): string | undefined {
  const write = new RegExp(`^repos/${repository}/issues/(\\d+)/comments$`).exec(endpoint)
  if (write === null || !args.includes('POST')) return undefined
  const encodedBody = args.find((value) => value.startsWith('body='))
  if (encodedBody === undefined) throw new Error('missing GitHub comment body')
  const stored = input.append(
    Number(write[1]),
    encodedBody.slice('body='.length),
    input.postStoredAuthor ?? 'automation',
  )
  return JSON.stringify({ ...stored, user: { login: input.postResponseAuthor ?? 'automation' } })
}

export function recoveryGhTransport(input: RecoveryGhTransportInput): Gh {
  return fakeGh([
    (args) => {
      if (args.join(' ') === 'repo view --json nameWithOwner -q .nameWithOwner') return repository
      if (args[0] === 'api' && args[1] === 'user') return 'automation'
      const endpoint = issueCommentsEndpoint(args)
      if (endpoint === undefined) return undefined
      return readComments(endpoint, input.comments) ?? postComment(input, args, endpoint)
    },
  ])
}
