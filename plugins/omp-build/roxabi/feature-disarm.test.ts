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

const { readEpicControlTarget } = vi.hoisted(() => ({ readEpicControlTarget: vi.fn() }))

vi.mock('../skills/feature/epic-driver-control.ts', () => ({ readEpicControlTarget }))

import { legacyFixtures } from './__tests__/uw-successor-selection-support.ts'
import { disarmKnownTarget } from './feature-disarm.ts'

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

function linkedReply(args: string[], linkedResponse: string | Error, hasNextPage: boolean): GhReply | null {
  if (args[0] !== 'api' || args[1] !== 'graphql' || !args.some((arg) => arg.includes('query LinkedPullRequests(')))
    return null
  if (linkedResponse instanceof Error) throw linkedResponse
  let nodes: unknown
  try {
    nodes = JSON.parse(linkedResponse)
  } catch {
    return { output: linkedResponse }
  }
  const home = { nameWithOwner: 'acme/app' }
  const owned = Array.isArray(nodes)
    ? nodes.map((node) =>
        node !== null && typeof node === 'object' && !('repository' in node) ? { ...node, repository: home } : node,
      )
    : nodes
  const linked = { pageInfo: { hasNextPage }, nodes: owned }
  return { output: JSON.stringify({ data: { repository: { issue: { closedByPullRequestsReferences: linked } } } }) }
}

function listReply(args: string[]): GhReply | null {
  if (args[0] !== 'pr' || args[1] !== 'list') return null
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

function ghForDiscovery(linkedResponse: string | Error, branch = 'feat/42', hasNextPage = false): GhFixture {
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
      const listed = linkedReply(args, linkedResponse, hasNextPage) ?? listReply(args)
      if (listed !== null) return listed.output
      if (args[0] === 'api' || (args[0] === 'repo' && args[1] === 'view')) {
        const response = run(box.file, args, box.root)
        if (response.status !== 0) throw new Error(response.stderr)
        return response.stdout.trim()
      }
      if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefName,baseRefName')) {
        return JSON.stringify({ headRefName: branch, baseRefName: 'main' })
      }
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
  // This branchless Parent binding is a historical association, not a newly admitted binding.
  const mandate = legacyFixtures.epicMandate(target.scope, [child], { recordId: 'mandate-42' })
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
  readEpicControlTarget.mockReset()
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
})

describe('Feature and Epic disarm discovery', () => {
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

  it('disarms first-page linked PRs but stays unconfirmed when more pages exist', async () => {
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9, state: 'OPEN' }]), 'feat/42', true)
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', null, featureAuthority())

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: 'pull-request-list-incomplete' } })
  })

  it('ignores a linked PR from another repository', async () => {
    const foreign = { number: 4672, state: 'OPEN', repository: { nameWithOwner: 'other/app' } }
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9, state: 'OPEN' }, foreign]))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', null, featureAuthority())

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: true })
  })

  it.each([
    ['feature', false],
    ['feature', true],
    ['epic', false],
    ['epic', true],
  ] as const)('refuses %s disarm without selected authority (empty discovery: %s)', async (role, empty) => {
    readEpicControlTarget.mockResolvedValue({ mandateId: 'mandate-42', control: 'active', openPrs: [] })
    const fixture = ghForDiscovery(JSON.stringify(empty ? [] : [{ number: 9, state: 'OPEN' }]))

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, role, null, null)

    expect(fixture.gates.get(9)).toEqual({ reviewed: true, autoMerge: true })
    expect(result).toMatchObject({
      clean: false,
      evidence: { note: 'pull-request-list-incomplete', discovery: { own: { incomplete: true } } },
    })
  })

  it('disarms parent and current approved child PRs', async () => {
    readEpicControlTarget.mockResolvedValue({
      mandateId: 'mandate-42',
      control: 'abandoned',
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
    readEpicControlTarget.mockRejectedValue(new Error('accepted child replay unavailable'))
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
