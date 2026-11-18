import { afterEach, expect, test, vi } from 'vitest'
import { diagnostic } from '../../adapters/github/types.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { type FeatureAuthority, resolveFeatureAuthority } from '../feature-continuation-admission.ts'
import type { ContinueFeatureResult } from '../feature-contract.ts'
import { inhibit, inhibition, releaseInhibition } from '../feature-control.ts'
import { disarmKnownTarget } from '../feature-disarm.ts'
import { type Contracts, loadContracts } from '../feature-engine.ts'
import { type FixUwCausalContext, readFreshUwCausalContext } from '../fix-uw-histories.ts'
import type { GitRunner } from '../workflow-checkout.ts'
import { successorGitHub } from './uw-successor-native-github.ts'

vi.mock('../feature-engine.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadContracts: vi.fn(),
}))
vi.mock('../fix-uw-histories.ts', () => ({
  readFreshUwCausalContext: vi.fn(),
}))
vi.mock('../feature-disarm.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disarmKnownTarget: vi.fn(async () => undefined),
}))

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const cwd = '/checkout'
const branch = 'feature/bounded'
const fixtures = roxabiWorkflowFixtures()
const mandate = fixtures.featureMandate(scope)
const history = fixtures.historyFrom([mandate])

type ComposedHistoryRead = Contracts['readComposedWorkflowHistory']
type ComposedHistoryResult = Awaited<ReturnType<ComposedHistoryRead>>

type AbandonAuthoritySetup = Readonly<{
  pending: Promise<FeatureAuthority | ContinueFeatureResult>
}>

afterEach(() => {
  releaseInhibition(scope)
  vi.clearAllMocks()
})

function fixtureGit(): GitRunner {
  const replies = new Map([
    ['rev-parse --show-toplevel', cwd],
    [
      'worktree list --porcelain',
      `worktree /principal\nbranch refs/heads/main\n\nworktree ${cwd}\nbranch refs/heads/${branch}\n`,
    ],
  ])
  return async (_cwd, args) => {
    const stdout = replies.get(args.join(' '))
    if (stdout === undefined) throw new Error(`unexpected Git request: ${args.join(' ')}`)
    return { code: 0, stdout, stderr: '' }
  }
}

async function maintainedContracts(readComposedWorkflowHistory: ComposedHistoryRead): Promise<Contracts> {
  const actual = await vi.importActual<typeof import('../feature-engine.ts')>('../feature-engine.ts')
  const contracts = await actual.loadContracts()
  if ('missing' in contracts) throw new Error(`engine-unavailable:${contracts.missing}`)
  return { ...contracts, readComposedWorkflowHistory }
}

function composedOk(histories: readonly (typeof history)[]): Extract<ComposedHistoryResult, { ok: true }> {
  return {
    ok: true,
    scopes: histories.map((entry) => entry.source.scope),
    histories: [...histories],
    records: histories.flatMap((entry) => [...recordsOf(entry)]),
  }
}

function composedUnreadable(): Extract<ComposedHistoryResult, { ok: false }> {
  return {
    ok: false,
    reason: 'unreadable',
    diagnostics: [diagnostic('unreadable', 'Fixture composed workflow history is unreadable')],
    histories: [],
  }
}

async function abandonAuthorityPending(read: ComposedHistoryRead): Promise<AbandonAuthoritySetup> {
  const github = successorGitHub({
    42: { title: 'Abandon-hold admission', body: '', labels: [], parent: null, blockers: [] },
  })
  const observed = await observeFixtureNativeWorld({
    root: scope,
    nodes: [
      {
        scope,
        title: 'Abandon-hold admission',
        body: '',
        updatedAt: '2026-10-21T00:00:00Z',
        labels: [],
        parent: null,
        children: [],
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      },
    ],
    histories: [history],
    pullRequests: [],
    commits: [],
    comparisons: [],
  })
  const causal: FixUwCausalContext = {
    histories: observed.histories,
    catalogues: observed.catalogues,
    observation: observed.observation,
  }
  vi.mocked(readFreshUwCausalContext).mockResolvedValue({ ok: true, value: causal })

  const entered = Promise.withResolvers<void>()
  const gatedRead = vi.fn(async (...args: Parameters<ComposedHistoryRead>): Promise<ComposedHistoryResult> => {
    entered.resolve()
    return read(...args)
  })
  vi.mocked(loadContracts).mockResolvedValue(await maintainedContracts(gatedRead))

  const pending = resolveFeatureAuthority({
    cwd,
    reference: scope.target,
    control: 'abandon',
    principal: false,
    git: fixtureGit(),
    gh: github.gh,
  })
  const race = await Promise.race([
    entered.promise.then(() => ({ kind: 'entered' as const })),
    pending.then((result) => ({ kind: 'early' as const, result })),
  ])
  if (race.kind === 'early') {
    throw new Error(
      `authority-read never entered; resolveFeatureAuthority settled early: ${JSON.stringify(race.result)}`,
    )
  }
  expect(gatedRead).toHaveBeenCalledOnce()
  expect(inhibition(scope)).toBe('abandon')
  // Object wrapper: awaiting this helper must not assimilate `pending`.
  return { pending }
}

test.each(['pause', 'abandon'] as const)(
  'authority-read replacement with newer %s preserves the replacement on successful admission',
  async (replacement) => {
    const { promise, resolve } = Promise.withResolvers<ComposedHistoryResult>()
    const read: ComposedHistoryRead = async () => promise
    const { pending } = await abandonAuthorityPending(read)
    expect(inhibition(scope)).toBe('abandon')
    const replacementEntry = inhibit(scope, replacement)
    resolve(composedOk([history]))
    const authority = await pending
    expect('kind' in authority).toBe(false)
    if ('kind' in authority) throw new Error('expected FeatureAuthority')
    expect(authority.controlInhibition?.control).toBe('abandon')
    expect(authority.controlInhibition).not.toBe(replacementEntry)
    expect(inhibition(scope)).toBe(replacement)
  },
)

test('authority-read ABA abandon→pause→abandon preserves the later abandon entry', async () => {
  const { promise, resolve } = Promise.withResolvers<ComposedHistoryResult>()
  const read: ComposedHistoryRead = async () => promise
  const { pending } = await abandonAuthorityPending(read)
  inhibit(scope, 'pause')
  const later = inhibit(scope, 'abandon')
  resolve(composedOk([history]))
  const authority = await pending
  expect('kind' in authority).toBe(false)
  if ('kind' in authority) throw new Error('expected FeatureAuthority')
  expect(authority.controlInhibition?.control).toBe('abandon')
  expect(authority.controlInhibition).not.toBe(later)
  expect(inhibition(scope)).toBe('abandon')
})

test('unreadable history admission retains the abandon hold and blocks as abandon-uncertain', async () => {
  const { promise, resolve } = Promise.withResolvers<ComposedHistoryResult>()
  const read: ComposedHistoryRead = async () => promise
  const { pending } = await abandonAuthorityPending(read)
  resolve(composedUnreadable())
  await expect(pending).resolves.toEqual({ kind: 'blocked', reason: 'abandon-uncertain' })
  expect(inhibition(scope)).toBe('abandon')
  expect(disarmKnownTarget).toHaveBeenCalled()
})

test('empty composed histories retain the abandon hold', async () => {
  const { promise, resolve } = Promise.withResolvers<ComposedHistoryResult>()
  const read: ComposedHistoryRead = async () => promise
  const { pending } = await abandonAuthorityPending(read)
  resolve(composedOk([]))
  await expect(pending).resolves.toEqual({ kind: 'blocked', reason: 'abandon-uncertain' })
  expect(inhibition(scope)).toBe('abandon')
})
