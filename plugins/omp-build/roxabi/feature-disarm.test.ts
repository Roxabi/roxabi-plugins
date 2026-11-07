import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateComposedWorkflowHistories } from '../adapters/github-workflow/history.ts'
import * as contracts from '../contracts.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import {
  base,
  dispose,
  openState,
  pull,
  run,
  saved,
} from '../skills/feature/testing/gh-simulator/sim-transport-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'

const { epicControlTarget } = vi.hoisted(() => ({ epicControlTarget: vi.fn() }))

vi.mock('../skills/feature/epic-driver.ts', () => ({ epicControlTarget }))

import { disarmBranchBeforePush, disarmKnownTarget, disarmUnresolved } from './feature-disarm.ts'

type Gate = { reviewed: boolean; autoMerge: boolean }
type GhReply = { output: string }

type GhFixture = {
  gh: (cwd: string, args: string[]) => Promise<string>
  gates: Map<number, Gate>
  comments: (pr: number) => string[]
}
const simulatorRoots: string[] = []
afterEach(() => {
  for (const root of simulatorRoots.splice(0)) dispose(root)
  vi.unstubAllEnvs()
})

function listReply(args: string[], linkedResponse: string | Error): GhReply | null {
  if (args[0] !== 'pr' || args[1] !== 'list') return null
  if (args.includes('--search')) {
    if (linkedResponse instanceof Error) throw linkedResponse
    return { output: linkedResponse }
  }
  return args.includes('--head') ? { output: JSON.stringify([{ number: 9, state: 'OPEN' }]) } : null
}

function gateReply(args: string[], gates: Map<number, Gate>): GhReply | null {
  if (args[0] !== 'pr') return null
  const number = Number(args[2])
  const gate = gates.get(number)
  if (!Number.isInteger(number) || !gate) return null
  if (args[1] === 'view') {
    return {
      output: JSON.stringify({
        state: 'OPEN',
        labels: gate.reviewed ? [{ name: 'reviewed' }] : [],
        autoMergeRequest: gate.autoMerge ? {} : null,
        mergeStateStatus: 'CLEAN',
      }),
    }
  }
  if (args[1] === 'merge' && args.includes('--disable-auto')) {
    gate.autoMerge = false
    return { output: '' }
  }
  if (args[1] === 'edit' && args.includes('--remove-label')) {
    gate.reviewed = false
    return { output: '' }
  }
  return null
}

function ghForDiscovery(linkedResponse: string | Error, branch = 'feat/42'): GhFixture {
  const gates = new Map<number, Gate>([
    [9, { reviewed: true, autoMerge: true }],
    [10, { reviewed: true, autoMerge: true }],
  ])
  const box = openState(
    base({
      remoteRefs: { main: 'b'.repeat(40) },
      prs: {
        9: pull(9, branch, 'a'.repeat(40), { baseRefOid: 'b'.repeat(40) }),
        10: pull(10, branch, 'a'.repeat(40), { baseRefOid: 'b'.repeat(40) }),
      },
    }),
  )
  simulatorRoots.push(box.root)
  return {
    gates,
    comments: (pr) => saved(box.file).prs[String(pr)].comments.map((comment) => comment.body),
    async gh(_cwd, args) {
      if (args[0] === 'api' || (args[0] === 'repo' && args[1] === 'view')) {
        const response = run(box.file, args, box.root)
        if (response.status !== 0) throw new Error(response.stderr)
        return response.stdout.trim()
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefName,baseRefName')) {
        return JSON.stringify({ headRefName: branch, baseRefName: 'main' })
      }
      const listed = listReply(args, linkedResponse)
      if (listed !== null) return listed.output
      const gated = gateReply(args, gates)
      if (gated !== null) return gated.output
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    },
  }
}

const target = {
  status: 'issue' as const,
  scope: { repository: 'acme/app', target: 'acme/app#42' },
  issue: { number: 42 },
}

describe('branch push withdrawal discovery', () => {
  it('permits a push only after complete empty PR enumeration', async () => {
    const calls: string[][] = []
    const gh = async (_cwd: string, args: string[]) => {
      calls.push(args)
      return '[]'
    }
    expect(await disarmBranchBeforePush(gh, '/repo', 'acme/app', 'feat/42')).toBe(true)
    expect(calls).toEqual([['api', 'repos/acme/app/pulls?state=all&head=acme%3Afeat%2F42&per_page=100&page=1']])
  })

  it.each(['{}', '[[{"number":0}]]', '[[{"number":9}],null]'])(
    'refuses incomplete or malformed enumeration %s',
    async (response) => {
      expect(await disarmBranchBeforePush(async () => response, '/repo', 'acme/app', 'feat/42')).toBe(false)
    },
  )

  it('withdraws every unmerged branch PR, including closed PRs, but not merged PRs', async () => {
    const fixture = ghForDiscovery('[]')
    const gh = async (cwd: string, args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('/pulls?state=all&head=')) {
        return JSON.stringify([
          { number: 9, state: 'open', merged_at: null },
          { number: 10, state: 'closed', merged_at: null },
          { number: 11, state: 'closed', merged_at: '2026-01-01T00:00:00Z' },
        ])
      }
      return fixture.gh(cwd, args)
    }
    expect(await disarmBranchBeforePush(gh, '/workspace', 'acme/app', 'feat/42')).toBe(true)
    expect(fixture.comments(9).some((body) => body.includes('"kind":"withdraw"'))).toBe(true)
    expect(fixture.comments(10).some((body) => body.includes('"kind":"withdraw"'))).toBe(true)
  })

  it('refuses when a discovered PR cannot be withdrawn', async () => {
    const gh = async (_cwd: string, args: string[]) => {
      if (args[0] === 'api') return JSON.stringify([{ number: 9, state: 'open', merged_at: null }])
      throw new Error('withdrawal unavailable')
    }
    expect(await disarmBranchBeforePush(gh, '/repo', 'acme/app', 'feat/42')).toBe(false)
  })
})

function composedHistory(histories: DecodedHistory[]) {
  const validated = validateComposedWorkflowHistories(histories)
  if (!validated.ok) throw new Error(`invalid fixture histories: ${validated.reason}`)
  return {
    ok: true as const,
    scopes: histories.map((history) => history.source.scope),
    histories,
    records: validated.records,
  }
}

function featureAuthority() {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(target.scope, { branch: 'feat/42' })
  const mandateHistory = fixtures.historyFrom([mandate])
  const binding = fixtures.workflowBinding(contracts.githubScope('acme/app', 9), mandate, 'feat/42', 'main')
  const prHistory = fixtures.historyFrom([binding], 'operator', 'operator', [mandateHistory])
  return {
    mandate: fixtures.mandateRef(mandate),
    loaded: {
      ...contracts,
      readComposedWorkflowHistory: async () => composedHistory([prHistory, mandateHistory]),
    },
  }
}

function epicAuthority() {
  const fixtures = roxabiWorkflowFixtures()
  const child = fixtures.childSnapshot(contracts.githubScope('acme/app', 43), '## Acceptance\n- [ ] Deliver the child')
  const mandate = fixtures.epicMandate(target.scope, [child], { recordId: 'mandate-42' })
  const mandateHistory = fixtures.historyFrom([mandate])
  const prScope = contracts.githubScope('acme/app', 9)
  const binding = fixtures.workflowBinding(prScope, mandate, 'epic/42', 'main')
  const prHistory = fixtures.historyFrom([binding], 'operator', 'operator', [mandateHistory])
  return {
    mandate: fixtures.mandateRef(mandate),
    loaded: {
      ...contracts,
      readComposedWorkflowHistory: async () => composedHistory([prHistory, mandateHistory]),
    },
  }
}

beforeEach(() => {
  epicControlTarget.mockReset()
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
})

describe('Feature pause disarm discovery', () => {
  it('refuses complete disarm when linked discovery fails after branch PR 9 disarms', async () => {
    const fixture = ghForDiscovery(new Error('linked query unavailable'))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42', featureAuthority())

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: expect.stringMatching(/pull-request-list/) } })
  })

  it('confirms complete valid discovery after PR 9 is unarmed', async () => {
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9, state: 'OPEN' }]))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42', featureAuthority())
    expect(fixture.comments(9).some((body) => body.includes('"kind":"withdraw"'))).toBe(true)

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: true })
  })

  it.each([
    ['malformed JSON', '{not json'],
    ['non-array', JSON.stringify({ number: 9 })],
    ['invalid entries', JSON.stringify([{ number: '9' }])],
    ['partially invalid entries', JSON.stringify([{ number: 9 }, { number: '10' }])],
  ])('refuses complete disarm for %s linked discovery', async (_name, linkedResponse) => {
    const fixture = ghForDiscovery(linkedResponse)
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42', featureAuthority())

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: expect.stringMatching(/pull-request-list/) } })
  })

  it.each([
    ['feature', false],
    ['feature', true],
    ['epic', false],
    ['epic', true],
  ] as const)('refuses %s disarm without selected authority (empty discovery: %s)', async (role, empty) => {
    epicControlTarget.mockResolvedValue({ mandateId: 'mandate-42', control: 'paused', openPrs: [] })
    const fixture = ghForDiscovery(JSON.stringify(empty ? [] : [{ number: 9, state: 'OPEN' }]))

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, role, null, null)

    expect(fixture.gates.get(9)).toEqual({ reviewed: true, autoMerge: true })
    expect(result).toMatchObject({
      clean: false,
      evidence: { note: 'pull-request-list-incomplete', discovery: { own: { incomplete: true } } },
    })
  })

  it('disarms parent and current approved child PRs', async () => {
    epicControlTarget.mockResolvedValue({
      mandateId: 'mandate-42',
      control: 'paused',
      openPrs: [
        { ticket: 42, pr: 9 },
        { ticket: 43, pr: 10 },
      ],
    })
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9, state: 'OPEN' }]), 'epic/42')

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'epic', null, epicAuthority())

    expect(fixture.gates).toEqual(
      new Map([
        [9, { reviewed: false, autoMerge: false }],
        [10, { reviewed: false, autoMerge: false }],
      ]),
    )
    expect(result).toMatchObject({ clean: true })
  })

  it('refuses confirmation when approved-child discovery is unavailable', async () => {
    epicControlTarget.mockRejectedValue(new Error('accepted child replay unavailable'))
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9, state: 'OPEN' }]), 'epic/42')

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'epic', null, epicAuthority())

    expect(fixture.gates).toEqual(
      new Map([
        [9, { reviewed: false, autoMerge: false }],
        [10, { reviewed: true, autoMerge: true }],
      ]),
    )
    expect(result).toMatchObject({
      clean: false,
      evidence: { note: 'pull-request-list-incomplete', discovery: { children: { incomplete: true } } },
    })
  })
})

describe('unresolved explicit reference containment', () => {
  function localPullRequest() {
    const gate = { reviewed: true, autoMerge: true }
    const gates = new Map([[42, gate]])
    const box = openState(
      base({
        remoteRefs: { main: 'b'.repeat(40) },
        prs: { 42: pull(42, 'feat/42', 'a'.repeat(40), { baseRefOid: 'b'.repeat(40) }) },
      }),
    )
    simulatorRoots.push(box.root)
    const gh = async (_cwd: string, args: string[]) => {
      if (args[0] === 'api' || (args[0] === 'repo' && args[1] === 'view')) {
        const response = run(box.file, args, box.root)
        if (response.status !== 0) throw new Error(response.stderr)
        return response.stdout.trim()
      }
      const reply = gateReply(args, gates)
      if (reply !== null) return reply.output
      throw new Error(`unexpected gh call: ${args.join(' ')}`)
    }
    return { gh, gate, comments: () => saved(box.file).prs['42'].comments.map((comment) => comment.body) }
  }

  it.each(['42', '#42', 'acme/app#42'])('still disarms the explicitly selected local PR %s', async (reference) => {
    const fixture = localPullRequest()
    await disarmUnresolved(fixture.gh, '/workspace', reference)
    expect(fixture.gate).toEqual({ reviewed: false, autoMerge: false })
    expect(fixture.comments().some((body) => body.includes('"kind":"withdraw"'))).toBe(true)
  })

  it('does not disarm the local PR sharing a foreign selected reference number', async () => {
    const fixture = localPullRequest()
    await disarmUnresolved(fixture.gh, '/workspace', 'other/service#42')
    expect(fixture.gate).toEqual({ reviewed: true, autoMerge: true })
    expect(fixture.comments()).toEqual([])
  })
})
