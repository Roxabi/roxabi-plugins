import { beforeEach, describe, expect, it, vi } from 'vitest'

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

function ghForDiscovery(linkedResponse: string | Error): GhFixture {
  const gates = new Map<number, Gate>([
    [9, { reviewed: true, autoMerge: true }],
    [10, { reviewed: true, autoMerge: true }],
  ])
  return {
    gates,
    async gh(_cwd, args) {
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

beforeEach(() => {
  epicControlTarget.mockReset()
})

describe('Feature pause disarm discovery', () => {
  it('refuses complete disarm when linked discovery fails after branch PR 9 disarms', async () => {
    const fixture = ghForDiscovery(new Error('linked query unavailable'))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42')

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: expect.stringMatching(/pull-request-list/) } })
  })

  it('confirms complete valid discovery after PR 9 is unarmed', async () => {
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]))
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42')

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
    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'feature', 'feat/42')

    expect(fixture.gates.get(9)).toEqual({ reviewed: false, autoMerge: false })
    expect(result).toMatchObject({ clean: false, evidence: { note: expect.stringMatching(/pull-request-list/) } })
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
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]))

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'epic')

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
    const fixture = ghForDiscovery(JSON.stringify([{ number: 9 }]))

    const result = await disarmKnownTarget(fixture.gh, '/workspace', target, 'epic')

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
