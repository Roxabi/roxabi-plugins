import { beforeEach, describe, expect, it, vi } from 'vitest'
import { validateComposedWorkflowHistories } from '../adapters/github-workflow/history.ts'
import * as contracts from '../contracts.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'

const { epicControlTarget } = vi.hoisted(() => ({ epicControlTarget: vi.fn() }))

vi.mock('../skills/feature/epic-driver.ts', () => ({ epicControlTarget }))

import { disarmKnownTarget } from './feature-disarm.ts'

type Gate = { reviewed: boolean; autoMerge: boolean }
type GhReply = { output: string }

type GhFixture = {
  gh: (cwd: string, args: string[]) => Promise<string>
  gates: Map<number, Gate>
}

function listReply(args: string[], linkedResponse: string | Error): GhReply | null {
  if (args[0] !== 'pr' || args[1] !== 'list') return null
  if (args.includes('--search')) {
    if (linkedResponse instanceof Error) throw linkedResponse
    return { output: linkedResponse }
  }
  return args.includes('--head') ? { output: JSON.stringify([{ number: 9 }]) } : null
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
  return {
    gates,
    async gh(_cwd, args) {
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
})

describe('Feature pause disarm discovery', () => {
  it('refuses complete disarm when linked discovery fails after branch PR 9 disarms', async () => {
    const fixture = ghForDiscovery(new Error('linked query unavailable'))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42', featureAuthority())

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: expect.stringMatching(/pull-request-list/) } })
  })

  it('confirms complete valid discovery after PR 9 is unarmed', async () => {
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42', featureAuthority())

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
    const fixture = ghForDiscovery(JSON.stringify(empty ? [] : [{ number: 9 }]))

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
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]), 'epic/42')

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
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]), 'epic/42')

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
