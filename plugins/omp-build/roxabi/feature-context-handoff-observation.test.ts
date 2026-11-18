import { describe, expect, it } from 'vitest'
import { appendRecords } from '../engine/__tests__/workflow-interruption-support.ts'
import { history, mandate } from '../engine/__tests__/workflow-test-support.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import {
  contextHandoffHistoryCut,
  contextHandoffHistoryDigest,
  contextHandoffPrefixDigest,
  contextHandoffPrefixHistories,
} from '../engine/workflow-context-handoff-history.ts'
import { contextHandoffDeliveryClear, observeContextHandoffCandidate } from './feature-context-handoff-observation.ts'
import { projectConfirmedContextAppend } from './feature-succession-refresh.ts'

const baseline = 'a'.repeat(40)
const base = 'b'.repeat(40)

function world(overrides: Record<string, string | null> = {}) {
  const values: Record<string, string | null> = {
    'remote get-url origin': 'https://github.com/acme/app.git',
    'rev-parse --verify HEAD^{commit}': baseline,
    'branch --show-current': 'feature/bounded',
    'status --porcelain --untracked-files=all': '',
    'ls-remote --refs origin refs/heads/main': `${base}\trefs/heads/main`,
    'ls-remote --refs origin refs/heads/feature/bounded': '',
    ...overrides,
  }
  const git = async (_cwd: string, args: string[]) => {
    const value = values[args.join(' ')]
    return { code: value === null || value === undefined ? 1 : 0, stdout: value ?? '', stderr: '' }
  }
  const gh = async () => JSON.stringify({ nameWithOwner: 'acme/app' })
  return { git, gh, cwd: '/fixture', repository: 'acme/app', branch: 'feature/bounded', base: 'main', baseline }
}

describe('context handoff candidate observation', () => {
  it('pins historical authority while excluding only the prospective successor', () => {
    const predecessor = mandate()
    const successor = { ...mandate({ recordId: 'successor' }), operationId: 'op-mandate-successor' }
    const before = history([predecessor])
    const after = appendRecords(before, [successor])
    const scope = before.source.scope
    const excluded = { scope, recordId: successor.recordId, kind: 'mandate' as const }
    expect(contextHandoffHistoryDigest([after], [excluded])).toBe(contextHandoffHistoryDigest([before]))
    expect(contextHandoffHistoryDigest([after])).not.toBe(contextHandoffHistoryDigest([before]))
    const cut = contextHandoffHistoryCut([before])
    expect(contextHandoffPrefixDigest([after], cut)).toBe(contextHandoffHistoryDigest([before]))
    expect(contextHandoffPrefixHistories([after], cut)?.[0]?.operations).toEqual(before.operations)
    expect(contextHandoffPrefixHistories([history([successor])], cut)).toBeNull()
    expect(contextHandoffPrefixDigest([history([successor])], cut)).toBeNull()
  })

  it('projects only the exact confirmed successor append for delivery observation', () => {
    const predecessor = mandate()
    const successor = { ...mandate({ recordId: 'successor' }), operationId: 'op-mandate-successor' }
    const before = history([predecessor])
    const after = appendRecords(before, [successor])
    const ref = { scope: before.source.scope, recordId: successor.recordId, kind: 'mandate' as const }
    const input = { before, ref, payloadDigest: canonicalValueDigest(successor.payload) }
    expect(projectConfirmedContextAppend([after], input)).toEqual([before])
    expect(projectConfirmedContextAppend([after], { ...input, payloadDigest: 'wrong' })).toBeNull()
    const extra = { ...mandate({ recordId: 'extra' }), operationId: 'op-mandate-extra' }
    expect(projectConfirmedContextAppend([appendRecords(after, [extra])], input)).toBeNull()
    expect(projectConfirmedContextAppend([before], input)).toBeNull()
  })

  it('rejects observed delivery instead of adopting it into a new authority', () => {
    const delivery = {
      uw: { repository: 'acme/app', target: 'acme/app#42' },
      pullRequests: [],
      integrations: [],
      commits: [],
    }
    expect(contextHandoffDeliveryClear(delivery, delivery.uw)).toBe(true)
    expect(
      contextHandoffDeliveryClear(
        { ...delivery, commits: [{ code: { repository: 'acme/app', commit: baseline }, parents: [] }] },
        delivery.uw,
      ),
    ).toBe(false)
    expect(contextHandoffDeliveryClear(delivery, { repository: 'other/app', target: 'other/app#42' })).toBe(false)
  })

  it('observes a clean, original candidate with no remote branch without pushing', async () => {
    expect(await observeContextHandoffCandidate(world())).toEqual({
      ok: true,
      value: {
        repository: 'acme/app',
        branch: 'feature/bounded',
        base: 'main',
        head: baseline,
        remoteBranch: null,
        remoteBase: base,
        clean: true,
      },
    })
  })

  it('accepts an existing remote branch only at the original baseline', async () => {
    const input = world({
      'ls-remote --refs origin refs/heads/feature/bounded': `${baseline}\trefs/heads/feature/bounded`,
    })
    expect(await observeContextHandoffCandidate(input)).toMatchObject({
      ok: true,
      value: { head: baseline, remoteBranch: baseline },
    })
  })

  it.each<Record<string, string | null>>([
    { 'status --porcelain --untracked-files=all': '?? untracked.txt' },
    { 'rev-parse --verify HEAD^{commit}': 'c'.repeat(40) },
    { 'branch --show-current': 'other' },
    { 'ls-remote --refs origin refs/heads/feature/bounded': `${'c'.repeat(40)}\trefs/heads/feature/bounded` },
    { 'ls-remote --refs origin refs/heads/feature/bounded': `${baseline}\trefs/heads/other` },
    {
      'ls-remote --refs origin refs/heads/feature/bounded': `${baseline}\trefs/heads/feature/bounded\n${baseline}\trefs/heads/feature/bounded`,
    },
    { 'ls-remote --refs origin refs/heads/main': null },
  ])('refuses dirty, moved or unobservable candidate facts', async (overrides) => {
    expect(await observeContextHandoffCandidate(world(overrides))).toMatchObject({ ok: false })
  })

  it('refuses an origin owned by another repository', async () => {
    expect(
      await observeContextHandoffCandidate({
        ...world(),
        gh: async () => JSON.stringify({ nameWithOwner: 'other/app' }),
      }),
    ).toMatchObject({ ok: false })
  })
})
