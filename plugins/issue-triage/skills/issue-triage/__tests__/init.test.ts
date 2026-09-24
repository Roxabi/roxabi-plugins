import { describe, expect, it, vi } from 'vitest'
import { initIssues } from '../lib/init'

const CANONICAL = [
  'size:S',
  'size:F-lite',
  'size:F-full',
  'P0-critical',
  'P1-high',
  'P2-medium',
  'P3-low',
  'reviewed',
  'epic',
]

describe('init', () => {
  it('dry-run lists the plan and calls no writer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const writes = { ensure: 0, update: 0, contract: 0 }
    const plan = await initIssues(['--dry-run', '--repo', 'go-silex/extern-client-metalyde'], {
      cwdRepo: 'Roxabi/roxabi-plugins',
      listLabelNames: async () => ['bug', 'size: XS'],
      listIssueLabelSets: async () => [{ number: 12, labels: ['size: M', 'ready-for-agent'], body: 'Blocked by: #4' }],
      ensureLabel: async () => {
        writes.ensure += 1
        return 'created'
      },
      updateLabels: async () => {
        writes.update += 1
      },
      readContract: () => null,
      writeContract: () => {
        writes.contract += 1
      },
    })
    expect(writes).toEqual({ ensure: 0, update: 0, contract: 0 })
    expect(plan.repo).toBe('go-silex/extern-client-metalyde')
    expect(plan.createLabels).toEqual(expect.arrayContaining(['size:S', 'reviewed', 'epic']))
    expect(plan.createLabels).not.toContain('size: XS')
    expect(plan.relabels).toEqual([{ number: 12, add: ['size:F-lite'], remove: ['size: M', 'ready-for-agent'] }])
    expect(plan.proseBlockedBy).toEqual([12])
    expect(plan.contract).toBe('skip-other-repo')
    vi.restoreAllMocks()
  })

  it('a real run writes through the adapter, and the second run writes nothing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const labels = ['bug']
    const issues = [{ number: 3, labels: ['priority: low'], body: '' }]
    let contract: string | null = null
    const writes = { ensure: 0, update: 0 }
    const deps = {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => [...labels],
      listIssueLabelSets: async () => issues.map((issue) => ({ ...issue, labels: [...issue.labels] })),
      ensureLabel: async (name: string) => {
        writes.ensure += 1
        labels.push(name)
        return 'created' as const
      },
      updateLabels: async (number: number, add: string[], remove: string[]) => {
        writes.update += 1
        const issue = issues.find((row) => row.number === number)
        if (!issue) throw new Error(`missing ${number}`)
        const drop = new Set(remove)
        issue.labels = [...issue.labels.filter((label) => !drop.has(label)), ...add]
      },
      readContract: () => contract,
      writeContract: (text: string) => {
        contract = text
      },
    }
    const first = await initIssues(['--repo', 'Acme/app'], deps)
    expect(writes.ensure).toBe(CANONICAL.length)
    expect(writes.update).toBe(1)
    expect(contract).toContain('Acme/app')
    expect(contract).toContain('issue-triage')
    expect(contract).toContain('only writer')
    expect(first.contract).toBe('write')

    writes.ensure = 0
    writes.update = 0
    const second = await initIssues(['--repo', 'Acme/app'], deps)
    expect(writes).toEqual({ ensure: 0, update: 0 })
    expect(second.relabels).toEqual([])
    expect(second.createLabels).toEqual([])
    expect(second.contract).toBe('unchanged')
    vi.restoreAllMocks()
  })
})
