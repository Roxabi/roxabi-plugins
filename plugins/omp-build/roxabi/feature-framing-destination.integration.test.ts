import { expect, it } from 'vitest'
import * as engine from '../contracts.ts'
import { resolveFramingReference } from './feature-continuation-admission.ts'

it('resolves a native issue on its actual scope and refuses a PR without reading its binding', async () => {
  const calls: string[][] = []
  const gh = async (_cwd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (args[0] === 'api' && args[1] === 'repos/acme/app/issues/4')
      return JSON.stringify({ number: 4, state: 'open', body: 'source', user: { login: 'operator' } })
    if (args[0] === 'api' && args[1] === 'repos/acme/app/issues/5')
      return JSON.stringify({ number: 5, state: 'open', body: 'source', pull_request: {}, user: { login: 'operator' } })
    if (args[0] === 'pr')
      return JSON.stringify({
        number: 5,
        state: 'OPEN',
        headRefOid: 'a'.repeat(40),
        headRefName: 'branch',
        baseRefName: 'main',
        baseRefOid: 'b'.repeat(40),
        mergeCommit: null,
        author: { login: 'operator' },
      })
    throw new Error(`Unexpected GitHub request: ${args.join(' ')}`)
  }
  const options = { cwd: '/work', gh, engine }
  expect(await resolveFramingReference({ ...options, reference: 'acme/app#4' })).toEqual({
    repository: 'acme/app',
    target: 'acme/app#4',
  })
  const ordinary = await engine.resolveNativeScope(
    { repository: 'acme/app', target: 'acme/app#4' },
    { cwd: '/work', gh },
  )
  if (ordinary.status !== 'issue') throw new Error('Expected native issue')
  expect(await resolveFramingReference({ ...options, reference: 'acme/app#4' })).toEqual(ordinary.scope)
  calls.length = 0
  expect(await resolveFramingReference({ ...options, reference: 'acme/app#5' })).toEqual({
    kind: 'blocked',
    reason: 'framing-reference-not-issue',
  })
  expect(calls.some((args) => args.some((arg) => arg.includes('comments')))).toBe(false)
  calls.length = 0
  expect(await resolveFramingReference({ ...options, reference: 'other/repo#4' })).toEqual({
    kind: 'blocked',
    reason: 'repository-mismatch',
  })
  expect(calls.every((args) => args[0] === 'repo')).toBe(true)
})
