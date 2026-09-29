import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  contractAction,
  contractFile,
  contractReader,
  initIssues,
  parseContractLabels,
  readContractFile,
  repoToplevel,
  secondPassIsNoop,
} from '../lib/init'

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
    expect(plan.createLabels).toEqual([])
    expect(plan.createLabels).not.toContain('epic')
    expect(plan.createLabels).not.toContain('reviewed')
    expect(plan.vocabulary).toBe('none')
    expect(plan.relabels).toEqual([{ number: 12, add: ['size:F-lite'], remove: ['size: M', 'ready-for-agent'] }])
    expect(plan.proseBlockedBy).toEqual([12])
    expect(plan.contract).toBe('skip-other-repo')
    expect(plan.refused.join('\n')).toContain('refusing without an explicit vocabulary')
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

  it('reads the template bullet list as canonical names only', () => {
    const template = '## Labels in use\n\n- `size:S`\n- `bug`\n- `wontfix`\n- `epic`\n'
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

describe('init vocabulary refusals', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads the contract from the git toplevel when cwd is a subdirectory', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'init-sub-'))
    const sub = path.join(root, 'apps')
    mkdirSync(sub, { recursive: true })
    mkdirSync(path.dirname(contractFile(root)), { recursive: true })
    writeFileSync(contractFile(root), KIT_CONTRACT)
    expect(repoToplevel(sub, () => root)).toBe(root)
    expect(readContractFile(repoToplevel(sub, () => root))).toBe(KIT_CONTRACT)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const plan = await initIssues(['--dry-run', '--repo', 'Acme/app'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => ['size:S'],
      listIssueLabelSets: async () => [],
      ensureLabel: async () => 'created',
      updateLabels: async () => {},
      readContract: contractReader(sub, () => root),
      writeContract: () => {
        throw new Error('subdirectory must not write a contract')
      },
    })
    expect(plan.contract).toBe('keep-existing')
    expect(plan.createLabels).not.toContain('epic')
    expect(plan.createLabels).not.toContain('reviewed')
    expect(plan.vocabulary).toBe('table')
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses --repo for another repository without using the local contract', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let read = 0
    const plan = await initIssues(['--dry-run', '--repo', 'Acme/other'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => [],
      listIssueLabelSets: async () => [],
      ensureLabel: async () => 'created',
      updateLabels: async () => {},
      readContract: () => {
        read += 1
        return KIT_CONTRACT
      },
      writeContract: () => {
        throw new Error('other repo must not write')
      },
    })
    expect(read).toBe(0)
    expect(plan.vocabulary).toBe('none')
    expect(plan.createLabels).toEqual([])
    await expect(
      initIssues(['--repo', 'Acme/other'], {
        cwdRepo: 'Acme/app',
        listLabelNames: async () => [],
        listIssueLabelSets: async () => [],
        ensureLabel: async () => 'created',
        updateLabels: async () => {},
        readContract: () => KIT_CONTRACT,
        writeContract: () => {
          throw new Error('other repo must not write')
        },
      }),
    ).rejects.toThrow(/refusing without an explicit vocabulary/)
  })

  it('refuses a contract that parses to no vocabulary instead of canonical labels', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      logs.push(String(line))
    })
    const plan = await initIssues(['--dry-run', '--repo', 'Acme/app'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => [],
      listIssueLabelSets: async () => [],
      ensureLabel: async () => 'created',
      updateLabels: async () => {},
      readContract: () => 'prose only, no label table\n',
      writeContract: () => {
        throw new Error('unparsed contract must not be written')
      },
    })
    expect(plan.vocabulary).toBe('none')
    expect(plan.createLabels).toEqual([])
    expect(plan.createLabels).not.toContain('epic')
    expect(logs.join('\n')).toContain('vocabulary: none parsed from docs/agents/issue-tracker.md')
    await expect(
      initIssues(['--repo', 'Acme/app'], {
        cwdRepo: 'Acme/app',
        listLabelNames: async () => [],
        listIssueLabelSets: async () => [],
        ensureLabel: async () => 'created',
        updateLabels: async () => {},
        readContract: () => 'prose only\n',
        writeContract: () => {
          throw new Error('unparsed contract must not be written')
        },
      }),
    ).rejects.toThrow(/vocabulary: none parsed/)
  })

  it('refuses a relabel target that is neither defined nor in the contract vocabulary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const onlySize = `| Label | Colour |\n|---|---|\n| \`size:S\` | \`bfd4f2\` |\n`
    await expect(
      initIssues(['--repo', 'Acme/app'], {
        cwdRepo: 'Acme/app',
        listLabelNames: async () => ['size:S'],
        listIssueLabelSets: async () => [{ number: 3, labels: ['priority: high'], body: '' }],
        ensureLabel: async () => 'created',
        updateLabels: async () => {
          throw new Error('must not relabel before the target exists')
        },
        readContract: () => onlySize,
        writeContract: () => {
          throw new Error('must not write')
        },
      }),
    ).rejects.toThrow(/P1-high: not in contract vocabulary, not on repo/)
  })

  it('reports a case mismatch instead of creating a second label', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const ensured: string[] = []
    const plan = await initIssues(['--dry-run', '--repo', 'Acme/app'], {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => ['p1-high'],
      listIssueLabelSets: async () => [],
      ensureLabel: async (name: string) => {
        ensured.push(name)
        return 'created'
      },
      updateLabels: async () => {},
      readContract: () => '| Label | Colour |\n|---|---|\n| `P1-high` | `d93f0b` |\n',
      writeContract: () => {
        throw new Error('must not write')
      },
    })
    expect(plan.createLabels).not.toContain('P1-high')
    expect(plan.refused.join('\n')).toContain('label case mismatch: P1-high: repo has p1-high')
    expect(ensured).toEqual([])
  })

  it('parses a GFM table whose columns are not indexes 1 and 2', () => {
    const gfm = 'Colour | Note | Label\n--- | --- | ---\n`bfd4f2` | tier | `size:S`\n'
    expect(parseContractLabels(gfm)).toEqual([{ name: 'size:S', color: 'bfd4f2' }])
  })

  it('a second run on the kit contract creates nothing and keeps the file', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const defined = KIT_LABELS.map((row) => row.name)
    let writes = 0
    let ensures = 0
    const deps = {
      cwdRepo: 'Acme/app',
      listLabelNames: async () => defined,
      listIssueLabelSets: async () => [],
      ensureLabel: async () => {
        ensures += 1
        return 'created' as const
      },
      updateLabels: async () => {},
      readContract: () => KIT_CONTRACT,
      writeContract: () => {
        writes += 1
      },
    }
    const first = await initIssues(['--repo', 'Acme/app'], deps)
    const second = await initIssues(['--repo', 'Acme/app'], deps)
    expect(first.contract).toBe('keep-existing')
    expect(second.contract).toBe('keep-existing')
    expect(second.createLabels).toEqual([])
    expect(writes).toBe(0)
    expect(ensures).toBe(0)
    expect(secondPassIsNoop([], defined, [], [], defined)).toBe(true)
    expect(secondPassIsNoop([], defined, [], [])).toBe(false)
  })
})
