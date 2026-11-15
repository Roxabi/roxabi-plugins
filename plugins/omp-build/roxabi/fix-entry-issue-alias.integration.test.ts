import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmingUwOperations } from '../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import type { IssueAliasReadPort } from './fix-entry-issue-alias.ts'
import { createResolver } from './fix-entry-target-resolver.ts'
import { prepareStandaloneFix, resolveFixTarget } from './fix-preparation.ts'

const boxes: string[] = []
afterEach(() => {
  for (const box of boxes.splice(0)) rmSync(box, { recursive: true, force: true })
})
const scope = { repository: 'acme/app', target: 'acme/app#42' }
const fixtures = roxabiWorkflowFixtures()

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'fix-alias-'))
  boxes.push(cwd)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-b', 'feat/42-save')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('commit', '--allow-empty', '-m', 'initial')
  const head = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', head)
  const mandate = fixtures.featureMandate(scope)
  const history = fixtures.historyFrom([mandate])
  const binding = fixtures.workflowBinding(
    { repository: scope.repository, target: 'acme/app#7' },
    mandate,
    'feat/42-save',
    'main',
  )
  const port: IssueAliasReadPort = {
    readHistory: async () => history,
    readBinding: async () => ({ binding, history, histories: [history] }),
  }
  let issueState = 'OPEN'
  let candidates = [{ number: 7, state: 'OPEN', isCrossRepository: false }]
  let prState = 'OPEN'
  const gh = async (_cwd: string, args: string[]) => {
    if (args[0] === 'issue') return JSON.stringify({ state: issueState })
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(candidates)
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7')
      return JSON.stringify({ state: prState, headRefName: 'feat/42-save', headRefOid: head, baseRefName: 'main' })
    throw new Error('not found')
  }
  return {
    cwd,
    port,
    gh,
    git,
    setIssue: (state: string) => {
      issueState = state
    },
    setCandidates: (value: typeof candidates) => {
      candidates = value
    },
    setPr: (state: string) => {
      prState = state
    },
  }
}

describe('issue alias resolution', () => {
  it('normalizes again during preparation and refuses discovery drift', async () => {
    const s = setup()
    const resolver = createResolver(s.cwd, s.gh, scope.repository, s.port)
    const first = await resolver.resolveExplicit('#42')
    expect(first.ok && first.value?.number).toBe(7)
    if (!first.ok || !first.value) throw new Error('expected PR')
    expect(await resolveFixTarget({ reference: '#42', contextTarget: first.value }, resolver)).toEqual(first)
    s.setCandidates([])
    expect(await resolveFixTarget({ reference: '#42', contextTarget: first.value }, resolver)).toEqual({
      ok: false,
      diagnostics: ['fix-issue-alias-no-pr'],
    })
  })

  it('requires the binding to name the current mandate, not merely its UW', async () => {
    const s = setup()
    const current = fixtures.featureMandate(scope, { recordId: 'mandate-current', operationId: 'op-current' })
    const history = fixtures.historyFrom([current])
    const stale = { ...s.port, readHistory: async () => history }
    const resolver = createResolver(s.cwd, s.gh, scope.repository, stale)
    expect(await resolver.resolveExplicit('#42')).toEqual({
      ok: false,
      diagnostics: ['fix-issue-alias-binding-mismatch'],
    })
    const binding = fixtures.workflowBinding(
      { repository: scope.repository, target: 'acme/app#7' },
      current,
      'feat/42-save',
      'main',
    )
    const matching = createResolver(s.cwd, s.gh, scope.repository, {
      ...stale,
      readBinding: async () => ({ binding, history, histories: [history] }),
    })
    const result = await matching.resolveExplicit('#42')
    expect(result.ok && result.value?.number).toBe(7)
  })

  it('refuses absent, ambiguous, incomplete, closed, merged and fork-only candidates', async () => {
    const s = setup()
    const resolver = createResolver(s.cwd, s.gh, scope.repository, s.port)
    const candidate = { number: 7, state: 'OPEN', isCrossRepository: false }
    for (const [candidates, code] of [
      [[], 'no-pr'],
      [[candidate, { ...candidate, number: 8 }], 'ambiguous'],
      [Array.from({ length: 30 }, () => candidate), 'incomplete'],
      [[{ ...candidate, state: 'CLOSED' }], 'closed'],
      [[{ ...candidate, isCrossRepository: true }], 'no-pr'],
    ] as const) {
      s.setCandidates([...candidates])
      expect(await resolver.resolveExplicit('#42')).toEqual({ ok: false, diagnostics: [`fix-issue-alias-${code}`] })
    }
    s.setCandidates([{ ...candidate, state: 'MERGED' }])
    s.setPr('MERGED')
    expect(await resolver.resolveExplicit('#42')).toEqual({ ok: false, diagnostics: ['fix-issue-alias-merged'] })
    s.setIssue('CLOSED')
    expect(await resolver.resolveExplicit('#42')).toEqual({ ok: false, diagnostics: ['fix-issue-alias-closed'] })
  })

  it('refuses missing or mismatched authority and a different local branch', async () => {
    const s = setup()
    const resolve = (port: IssueAliasReadPort) =>
      createResolver(s.cwd, s.gh, scope.repository, port).resolveExplicit('#42')
    expect(
      await resolve({
        ...s.port,
        readHistory: async () => {
          throw new Error('missing')
        },
      }),
    ).toEqual({ ok: false, diagnostics: ['fix-issue-alias-no-mandate'] })
    const noBranch = fixtures.featureMandate(scope, { branch: null })
    expect(await resolve({ ...s.port, readHistory: async () => fixtures.historyFrom([noBranch]) })).toEqual({
      ok: false,
      diagnostics: ['fix-issue-alias-no-branch'],
    })
    expect(await resolve({ ...s.port, readBinding: async () => null })).toEqual({
      ok: false,
      diagnostics: ['fix-issue-alias-binding-missing'],
    })
    const other = { repository: scope.repository, target: 'acme/app#43' }
    const mandate = fixtures.featureMandate(other)
    const history = fixtures.historyFrom([mandate])
    const binding = fixtures.workflowBinding(
      { repository: scope.repository, target: 'acme/app#7' },
      mandate,
      'feat/42-save',
      'main',
    )
    expect(await resolve({ ...s.port, readBinding: async () => ({ binding, history }) })).toEqual({
      ok: false,
      diagnostics: ['fix-issue-alias-binding-mismatch'],
    })
    s.git('checkout', '-b', 'other')
    expect(await resolve(s.port)).toEqual({ ok: false, diagnostics: ['fix-issue-alias-branch-mismatch'] })
  })

  it('refuses an alias before preparing or publishing anything', async () => {
    const s = setup()
    const resolver = createResolver(s.cwd, s.gh, scope.repository, {
      ...s.port,
      readHistory: async () => {
        throw new Error('unavailable')
      },
    })
    let writes = 0
    let prepares = 0
    const operations = confirmingUwOperations()
    operations.prepareAction = async () => {
      prepares++
      throw new Error('unexpected prepare')
    }
    const result = await prepareStandaloneFix(
      {
        cwd: s.cwd,
        reference: '#42',
        rawOperatorRequest: { request: 'fix' },
        scope: 'fix',
        identity: { runId: 'run-1', operationId: 'op-1', nextRecordId: (kind) => `${kind}-1` },
        publishBinding: {
          pushUrl: 'https://github.com/acme/app.git',
          publicationRepository: 'acme/app',
          localBranch: 'feat/42-save',
          destinationRef: 'refs/heads/feat/42-save',
          localHead: 'a'.repeat(40),
          expectedRemoteSHA: 'a'.repeat(40),
          defaultBranch: 'main',
          observed: {},
        },
        nativeTasks: [{ name: 'slot-1', agent: 'R-adversarial', task: 'inspect', solutionSpace: 'correction' }],
        operations,
      },
      resolver,
      {
        publish: async () => {
          writes++
          return { ok: true, value: undefined }
        },
      },
    )
    expect(result).toEqual({ ok: false, diagnostics: ['fix-issue-alias-no-mandate'] })
    expect({ writes, prepares }).toEqual({ writes: 0, prepares: 0 })
  })
})
