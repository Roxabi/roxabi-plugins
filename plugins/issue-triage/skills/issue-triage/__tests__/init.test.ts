import { describe, expect, it, vi } from 'vitest'
import { contractAction, initIssues, parseContractLabels } from '../lib/init'

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

const KIT_CONTRACT = `# Issue tracker: GitHub

\`reviewed\` and \`epic\` are merge-gate labels, not triage.

| Label | τ | What it costs |
|---|---|---|
| \`size:S\` | S | No matrix |

| Role | Label | Colour |
|---|---|---|
| Size / tier | \`size:S\` | \`bfd4f2\` |
| Size / tier | \`size:F-lite\` | \`fbca04\` |
| Size / tier | \`size:F-full\` | \`d93f0b\` |
| Priority | \`P0-critical\` | \`b60205\` |
| Priority | \`P1-high\` | \`d93f0b\` |
| Priority | \`P2-medium\` | \`fbca04\` |
| Priority | \`P3-low\` | \`0e8a16\` |
`

const KIT_LABELS = [
  { name: 'size:S', color: 'bfd4f2' },
  { name: 'size:F-lite', color: 'fbca04' },
  { name: 'size:F-full', color: 'd93f0b' },
  { name: 'P0-critical', color: 'b60205' },
  { name: 'P1-high', color: 'd93f0b' },
  { name: 'P2-medium', color: 'fbca04' },
  { name: 'P3-low', color: '0e8a16' },
]

describe('contractAction', () => {
  it('writes when the contract is absent', () => {
    expect(contractAction('Acme/app', 'Acme/app', null, 'rendered')).toBe('write')
  })

  it('leaves a byte-identical template unchanged', () => {
    expect(contractAction('Acme/app', 'Acme/app', 'rendered', 'rendered')).toBe('unchanged')
  })

  it('keeps an authored contract that differs from the template', () => {
    expect(contractAction('Acme/app', 'Acme/app', KIT_CONTRACT, 'rendered')).toBe('keep-existing')
  })
})

describe('parseContractLabels', () => {
  it('reads the kit Label | Colour table and ignores prose epic/reviewed', () => {
    expect(parseContractLabels(KIT_CONTRACT)).toEqual(KIT_LABELS)
  })

  it('reads the template bullet list when there is no colour table', () => {
    const template = '## Labels in use\n\n- `size:S`\n- `epic`\n'
    expect(parseContractLabels(template)).toEqual([
      { name: 'size:S', color: 'ededed' },
      { name: 'epic', color: 'ededed' },
    ])
  })
})

describe('init keeps an authored contract', () => {
  it('dry-run prints contract: keep-existing and calls no writer', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line))
    })
    const writes = { ensure: 0, contract: 0 }
    const plan = await initIssues(['--dry-run', '--repo', 'Acme/app'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => ['size:S', 'bug'],
      listIssueLabelSets: async () => [],
      ensureLabel: async () => {
        writes.ensure += 1
        return 'created'
      },
      updateLabels: async () => {},
      readContract: () => KIT_CONTRACT,
      writeContract: () => {
        writes.contract += 1
      },
    })
    expect(writes).toEqual({ ensure: 0, contract: 0 })
    expect(plan.contract).toBe('keep-existing')
    expect(logs.join('\n')).toContain('contract: keep-existing')
    expect(plan.createLabels).toEqual(KIT_LABELS.map((row) => row.name).filter((name) => name !== 'size:S'))
    expect(plan.createLabels).not.toContain('epic')
    expect(plan.createLabels).not.toContain('reviewed')
    vi.restoreAllMocks()
  })

  it('creates only missing contract labels in their colours and does not recolour', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ensured: { name: string; color?: string }[] = []
    const plan = await initIssues(['--repo', 'Acme/app'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => ['size:S', 'bug'],
      listIssueLabelSets: async () => [],
      ensureLabel: async (name: string, _repo: string, color?: string) => {
        ensured.push({ name, color })
        return 'created'
      },
      updateLabels: async () => {},
      readContract: () => KIT_CONTRACT,
      writeContract: () => {
        throw new Error('authored contract must not be written')
      },
    })
    expect(plan.contract).toBe('keep-existing')
    expect(ensured).toEqual(
      KIT_LABELS.filter((row) => row.name !== 'size:S').map((row) => ({ name: row.name, color: row.color })),
    )
    expect(ensured.some((row) => row.name === 'size:S')).toBe(false)
    expect(ensured.some((row) => row.color === 'ededed')).toBe(false)
    vi.restoreAllMocks()
  })
})
