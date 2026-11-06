import { expect, it } from 'vitest'
import type { UwActionRequest } from './uw-action-contract.ts'
import { observeCode } from './uw-action-observe.ts'
import type { GitRunner } from './workflow-checkout.ts'

it('re-reads the declared worktree HEAD and refuses a moved, malformed, or failed observation', async () => {
  const selected = '1'.repeat(40)
  let observed = selected
  let exitCode = 0
  const calls: string[][] = []
  const git: GitRunner = async (_cwd, args) => {
    calls.push(args)
    if (args.join(' ') !== 'rev-parse HEAD') throw new Error('Undeclared Git read')
    return { code: exitCode, stdout: observed, stderr: '' }
  }
  const request: UwActionRequest = {
    actionId: 'head-observation',
    purpose: 'implement',
    subject: { kind: 'uw', uw: { repository: 'acme/app', target: 'acme/app#42' }, pullRequest: null, binding: null },
    code: { repository: 'acme/app', base: 'a'.repeat(40), head: selected, referenceCommit: selected },
    stageSources: [],
    expandedContext: [],
  }
  const source = {
    cwd: '/declared-worktree',
    git,
    gh: async () => {
      throw new Error('Unexpected GitHub read')
    },
  }
  expect(await observeCode(request, source)).toEqual({ ok: true, value: { branch: 'HEAD', baseName: 'HEAD' } })
  observed = '2'.repeat(40)
  expect(await observeCode(request, source)).toMatchObject({ ok: false, diagnostics: [{ code: 'action-code-moved' }] })
  observed = ''
  expect(await observeCode(request, source)).toMatchObject({ ok: false, diagnostics: [{ code: 'action-code-moved' }] })
  observed = selected
  exitCode = 1
  expect(await observeCode(request, source)).toMatchObject({ ok: false, diagnostics: [{ code: 'action-code-moved' }] })
  expect(calls).toEqual(Array.from({ length: 4 }, () => ['rev-parse', 'HEAD']))
})
