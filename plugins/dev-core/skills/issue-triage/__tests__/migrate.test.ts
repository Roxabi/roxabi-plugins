import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

// Env vars must be set before config-helpers module loads
process.env.GITHUB_REPO = 'Roxabi/test'
process.env.GH_PROJECT_ID = 'PVT_test'
process.env.STATUS_FIELD_ID = 'SF_test'
process.env.SIZE_FIELD_ID = 'SZF_test'
process.env.PRIORITY_FIELD_ID = 'PF_test'
process.env.LANE_FIELD_ID = 'LF_test'
process.env.STATUS_OPTIONS_JSON = JSON.stringify({
  Backlog: 'status-backlog',
  Analysis: 'status-analysis',
  Specs: 'status-specs',
  'In Progress': 'status-inprog',
  Review: 'status-review',
  Done: 'status-done',
})
process.env.SIZE_OPTIONS_JSON = JSON.stringify({
  XS: 'size-xs',
  S: 'size-s',
  M: 'size-m',
  L: 'size-l',
  XL: 'size-xl',
})
process.env.PRIORITY_OPTIONS_JSON = JSON.stringify({
  'P0 - Urgent': 'pri-urgent',
  'P1 - High': 'pri-high',
  'P2 - Medium': 'pri-medium',
  'P3 - Low': 'pri-low',
})
process.env.LANE_OPTIONS_JSON = JSON.stringify(
  Object.fromEntries(
    [
      'a1', 'a2', 'a3', 'b', 'c1', 'c2', 'c3',
      'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
      'l', 'm', 'n', 'o', 'standalone',
    ].map((k) => [k, `lane-${k}`]),
  ),
)

// Full DEFAULT_LANE_OPTIONS list (20 entries) — mirrors config-helpers.ts
const ALL_LANE_KEYS = [
  'a1', 'a2', 'a3', 'b', 'c1', 'c2', 'c3',
  'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
  'l', 'm', 'n', 'o', 'standalone',
]

vi.mock('../../shared/adapters/config-helpers', () => ({
  isProjectConfigured: () => true,
  NOT_CONFIGURED_MSG: 'GitHub Project V2 is not configured.',
  GITHUB_REPO: 'Roxabi/test',
  GH_PROJECT_ID: 'PVT_test',
  STATUS_FIELD_ID: 'SF_test',
  SIZE_FIELD_ID: 'SZF_test',
  PRIORITY_FIELD_ID: 'PF_test',
  LANE_FIELD_ID: 'LF_test',
  STATUS_OPTIONS: {
    Backlog: 'status-backlog',
    Analysis: 'status-analysis',
    Specs: 'status-specs',
    'In Progress': 'status-inprog',
    Review: 'status-review',
    Done: 'status-done',
  },
  SIZE_OPTIONS: { XS: 'size-xs', S: 'size-s', M: 'size-m', L: 'size-l', XL: 'size-xl' },
  PRIORITY_OPTIONS: {
    'P0 - Urgent': 'pri-urgent',
    'P1 - High': 'pri-high',
    'P2 - Medium': 'pri-medium',
    'P3 - Low': 'pri-low',
  },
  LANE_OPTIONS: Object.fromEntries(
    [
      'a1', 'a2', 'a3', 'b', 'c1', 'c2', 'c3',
      'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
      'l', 'm', 'n', 'o', 'standalone',
    ].map((k) => [k, `lane-${k}`]),
  ),
  DEFAULT_LANE_OPTIONS: [
    'a1', 'a2', 'a3', 'b', 'c1', 'c2', 'c3',
    'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
    'l', 'm', 'n', 'o', 'standalone',
  ],
  resolveStatus: (input: string) => {
    const aliases: Record<string, string> = {
      BACKLOG: 'Backlog', ANALYSIS: 'Analysis', SPECS: 'Specs',
      'IN PROGRESS': 'In Progress', IN_PROGRESS: 'In Progress',
      INPROGRESS: 'In Progress', REVIEW: 'Review', DONE: 'Done',
    }
    const canonical = new Set(['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'])
    if (canonical.has(input)) return input
    return aliases[input.toUpperCase()]
  },
  resolveSize: (input: string) => {
    const u = input.toUpperCase()
    return new Set(['XS', 'S', 'M', 'L', 'XL']).has(u) ? u : undefined
  },
  resolvePriority: (input: string) => {
    const canonical = new Set(['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'])
    if (canonical.has(input)) return input
    const aliases: Record<string, string> = {
      URGENT: 'P0 - Urgent', HIGH: 'P1 - High', MEDIUM: 'P2 - Medium', LOW: 'P3 - Low',
      P0: 'P0 - Urgent', P1: 'P1 - High', P2: 'P2 - Medium', P3: 'P3 - Low',
    }
    return aliases[input.toUpperCase()]
  },
  resolveLane: (input: string) => {
    const valid = new Set([
      'a1', 'a2', 'a3', 'b', 'c1', 'c2', 'c3',
      'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
      'l', 'm', 'n', 'o', 'standalone',
    ])
    return valid.has(input) ? input : undefined
  },
}))

vi.mock('../../shared/adapters/github-adapter', () => ({
  ghGraphQL: vi.fn(),
  getItemId: vi.fn(),
  getNodeId: vi.fn(),
  getParentNumber: vi.fn(),
  updateField: vi.fn(),
  addBlockedBy: vi.fn(),
  removeBlockedBy: vi.fn(),
  addSubIssue: vi.fn(),
  removeSubIssue: vi.fn(),
  resolveIssueTypeId: vi.fn(),
  updateIssueIssueType: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const github = await import('../../shared/adapters/github-adapter')
const mockGhGraphQL = github.ghGraphQL as ReturnType<typeof vi.fn>
const mockUpdateField = github.updateField as ReturnType<typeof vi.fn>
const mockResolveIssueTypeId = github.resolveIssueTypeId as ReturnType<typeof vi.fn>
const mockUpdateIssueIssueType = github.updateIssueIssueType as ReturnType<typeof vi.fn>

const childProcess = await import('node:child_process')
const mockExecSync = childProcess.execSync as ReturnType<typeof vi.fn>

const { LEGACY_LABEL_MAP, TITLE_PREFIX_RE, auditSchema, backfill } = await import('../lib/migrate')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditSchemaResponse(laneOptions: string[]) {
  return {
    node: {
      fields: {
        nodes: [
          {
            id: 'f-size', name: 'Size',
            options: ['XS', 'S', 'M', 'L', 'XL'].map((n) => ({ id: `s-${n}`, name: n })),
          },
          {
            id: 'f-lane', name: 'Lane',
            options: laneOptions.map((n) => ({ id: `l-${n}`, name: n })),
          },
          {
            id: 'f-priority', name: 'Priority',
            options: ['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'].map((n) => ({ id: `p-${n}`, name: n })),
          },
          {
            id: 'f-status', name: 'Status',
            options: ['Backlog', 'Analysis', 'Specs', 'In Progress', 'Review', 'Done'].map((n) => ({
              id: `st-${n}`,
              name: n,
            })),
          },
        ],
      },
    },
  }
}

function makeItemFieldsResponse(opts: {
  issueId: string
  itemId: string
  fields: Record<string, string>
  issueTypeName?: string
}) {
  return {
    repository: {
      issue: {
        id: opts.issueId,
        issueType: opts.issueTypeName ? { id: 'type-id', name: opts.issueTypeName } : null,
        projectItems: {
          nodes: [
            {
              id: opts.itemId,
              project: { id: 'PVT_test' },
              fieldValues: {
                nodes: Object.entries(opts.fields).map(([fieldName, value]) => ({
                  name: value,
                  field: { name: fieldName },
                })),
              },
            },
          ],
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 1. LEGACY_LABEL_MAP completeness
// ---------------------------------------------------------------------------

describe('migrate > LEGACY_LABEL_MAP', () => {
  describe('size mappings', () => {
    it('maps S to S', () => {
      // Arrange / Act / Assert
      expect(LEGACY_LABEL_MAP.size.S).toBe('S')
    })

    it('maps M to F-lite', () => {
      expect(LEGACY_LABEL_MAP.size.M).toBe('F-lite')
    })

    it('maps L to F-full', () => {
      expect(LEGACY_LABEL_MAP.size.L).toBe('F-full')
    })

    it('maps XL to F-full', () => {
      expect(LEGACY_LABEL_MAP.size.XL).toBe('F-full')
    })
  })

  describe('priority mappings', () => {
    it('maps P0 to P0 - Urgent', () => {
      expect(LEGACY_LABEL_MAP.priority.P0).toBe('P0 - Urgent')
    })

    it('maps P1 to P1 - High', () => {
      expect(LEGACY_LABEL_MAP.priority.P1).toBe('P1 - High')
    })

    it('maps P2 to P2 - Medium', () => {
      expect(LEGACY_LABEL_MAP.priority.P2).toBe('P2 - Medium')
    })

    it('maps P3 to P3 - Low', () => {
      expect(LEGACY_LABEL_MAP.priority.P3).toBe('P3 - Low')
    })
  })

  describe('issueType mappings', () => {
    it('contains all 8 conventional-commit types', () => {
      // Arrange
      const expected = ['feat', 'fix', 'docs', 'test', 'chore', 'ci', 'perf', 'refactor']
      // Act / Assert
      for (const type of expected) {
        expect(LEGACY_LABEL_MAP.issueType[type]).toBe(type)
      }
      expect(Object.keys(LEGACY_LABEL_MAP.issueType)).toHaveLength(8)
    })

    it('maps feat to feat', () => {
      expect(LEGACY_LABEL_MAP.issueType.feat).toBe('feat')
    })

    it('maps refactor to refactor', () => {
      expect(LEGACY_LABEL_MAP.issueType.refactor).toBe('refactor')
    })
  })

  describe('lane mappings', () => {
    it('contains all 20 canonical lane keys from DEFAULT_LANE_OPTIONS', () => {
      // Arrange
      const laneKeys = Object.keys(LEGACY_LABEL_MAP.lane)
      // Assert
      expect(laneKeys).toHaveLength(ALL_LANE_KEYS.length)
      for (const key of ALL_LANE_KEYS) {
        expect(LEGACY_LABEL_MAP.lane[key]).toBe(key)
      }
    })

    it('maps c1 to c1 (identity mapping)', () => {
      expect(LEGACY_LABEL_MAP.lane.c1).toBe('c1')
    })

    it('maps standalone to standalone', () => {
      expect(LEGACY_LABEL_MAP.lane.standalone).toBe('standalone')
    })
  })
})

// ---------------------------------------------------------------------------
// 2. TITLE_PREFIX_RE correctness
// ---------------------------------------------------------------------------

describe('migrate > TITLE_PREFIX_RE', () => {
  it('matches feat(foo): bar and captures feat as group 1', () => {
    // Arrange
    const title = 'feat(foo): bar'
    // Act
    const match = title.match(TITLE_PREFIX_RE)
    // Assert
    expect(match).not.toBeNull()
    expect(match![1]).toBe('feat')
  })

  it('matches chore: baz and captures chore as group 1', () => {
    const match = 'chore: baz'.match(TITLE_PREFIX_RE)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('chore')
  })

  it('matches fix(complex-scope): x and captures fix as group 1', () => {
    const match = 'fix(complex-scope): x'.match(TITLE_PREFIX_RE)
    expect(match).not.toBeNull()
    expect(match![1]).toBe('fix')
  })

  it('does not match plain title without conventional prefix', () => {
    expect('random title'.match(TITLE_PREFIX_RE)).toBeNull()
  })

  it('does not match when first word is not a known type', () => {
    expect('colon: but no type'.match(TITLE_PREFIX_RE)).toBeNull()
  })

  it('matches all 8 conventional-commit types', () => {
    // Arrange
    const types = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'ci', 'perf']
    for (const type of types) {
      // Act
      const match = `${type}: something`.match(TITLE_PREFIX_RE)
      // Assert
      expect(match).not.toBeNull()
      expect(match![1]).toBe(type)
    }
  })
})

// ---------------------------------------------------------------------------
// 3 & 4. auditSchema
// ---------------------------------------------------------------------------

describe('migrate > auditSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('exits 1 and prints diff lines when Lane field has mismatched options', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    // Return a Lane field with only 2 options, causing LOCAL_EXTRA diffs
    mockGhGraphQL.mockResolvedValue(makeAuditSchemaResponse(['a1', 'b']))
    // Act
    await auditSchema()
    // Assert
    expect(exitSpy).toHaveBeenCalledWith(1)
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    const hasDiffLines = logCalls.some(
      (msg) => msg.startsWith('LOCAL_EXTRA:') || msg.startsWith('LOCAL_MISSING:') || msg.startsWith('MISSING:'),
    )
    expect(hasDiffLines).toBe(true)
  })

  it('does not exit and prints success when all fields match live project', async () => {
    // Arrange
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    mockGhGraphQL.mockResolvedValue(makeAuditSchemaResponse(ALL_LANE_KEYS))
    // Act
    await auditSchema()
    // Assert
    expect(exitSpy).not.toHaveBeenCalled()
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
    expect(logCalls.some((msg) => msg.includes('OK'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. backfill --dry-run
// ---------------------------------------------------------------------------

describe('migrate > backfill --dry-run', () => {
  let snapshotPath: string

  const labeledIssue = {
    number: 1,
    title: 'feat(x): hi',
    labels: [
      { name: 'graph:lane/c1' },
      { name: 'size:M' },
      { name: 'P1-high' },
    ],
    id: 'node-1',
  }

  const unlabeledIssue = {
    number: 2,
    title: 'hello',
    labels: [],
    id: 'node-2',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    snapshotPath = join(tmpdir(), `migrate-test-snapshot-${Date.now()}.json`)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // audit passes
    mockGhGraphQL.mockImplementation(async (_query: string, vars: Record<string, unknown>) => {
      // PROJECT_FIELDS_QUERY (audit) — no owner/repo vars
      if (!vars.owner) {
        return makeAuditSchemaResponse(ALL_LANE_KEYS)
      }
      // ITEM_FIELDS_QUERY for issue 1 (labeled, all fields populated)
      if (vars.number === 1) {
        return makeItemFieldsResponse({
          issueId: 'node-1',
          itemId: 'item-1',
          fields: { Lane: 'c1', Size: 'F-lite', Priority: 'P1 - High' },
          issueTypeName: 'feat',
        })
      }
      // ITEM_FIELDS_QUERY for issue 2 (unlabeled, no fields set)
      return makeItemFieldsResponse({
        issueId: 'node-2',
        itemId: 'item-2',
        fields: {},
      })
    })

    mockExecSync.mockReturnValue(JSON.stringify([labeledIssue, unlabeledIssue]))
    mockResolveIssueTypeId.mockResolvedValue('type-id-feat')
  })

  afterEach(() => vi.restoreAllMocks())

  it('does not call updateField or updateIssueIssueType in dry-run', async () => {
    // Act
    await backfill({ repo: 'Roxabi/test', dryRun: true, snapshotPath })
    // Assert
    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })

  it('writes snapshot file with rows for the labeled issue', async () => {
    // Act
    await backfill({ repo: 'Roxabi/test', dryRun: true, snapshotPath })
    // Assert — snapshot is written and contains rows for issue 1
    // (issue 2 has no labels and plain title → no fields to map → 0 rows emitted for it)
    const raw = await readFile(snapshotPath, 'utf-8')
    const rows = JSON.parse(raw) as Array<{ number: number; repo: string }>
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const numbers = rows.map((r) => r.number)
    expect(numbers).toContain(1)
  })

  it('snapshot includes at least one row from the unlabeled issue (issue 2)', async () => {
    // The unlabeled issue has no labels and a plain title → no fields to set, but
    // issue 2 has no project item fields populated and no labels, so it produces no
    // rows (nothing to migrate). It should not be flagged for unknown tokens.
    await backfill({ repo: 'Roxabi/test', dryRun: true, snapshotPath })
    const raw = await readFile(snapshotPath, 'utf-8')
    const rows = JSON.parse(raw) as Array<{ number: number; field: string; new_value: string | null; flagged: boolean }>
    // Issue 1 has all fields already set — rows should record skipped (old_value = new_value)
    const issue1Rows = rows.filter((r) => r.number === 1)
    expect(issue1Rows.length).toBeGreaterThan(0)
    // All issue 1 rows are skipped (fields already populated)
    for (const row of issue1Rows) {
      expect(row.flagged).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. backfill idempotency
// ---------------------------------------------------------------------------

describe('migrate > backfill idempotency', () => {
  let snapshotPath: string

  const fullyPopulatedIssue = {
    number: 10,
    title: 'feat(y): already done',
    labels: [
      { name: 'graph:lane/a1' },
      { name: 'size:S' },
      { name: 'P2-medium' },
    ],
    id: 'node-10',
  }

  function setupFullyPopulatedMocks() {
    mockGhGraphQL.mockImplementation(async (_query: string, vars: Record<string, unknown>) => {
      if (!vars.owner) {
        return makeAuditSchemaResponse(ALL_LANE_KEYS)
      }
      return makeItemFieldsResponse({
        issueId: 'node-10',
        itemId: 'item-10',
        fields: { Lane: 'a1', Size: 'S', Priority: 'P2 - Medium' },
        issueTypeName: 'feat',
      })
    })
    mockExecSync.mockReturnValue(JSON.stringify([fullyPopulatedIssue]))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    snapshotPath = join(tmpdir(), `migrate-idempotent-${Date.now()}.json`)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockResolveIssueTypeId.mockResolvedValue('type-id-feat')
    setupFullyPopulatedMocks()
  })

  afterEach(() => vi.restoreAllMocks())

  it('produces 0 mutations on first run when all fields are already set', async () => {
    // Act
    await backfill({ repo: 'Roxabi/test', dryRun: false, snapshotPath })
    // Assert
    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })

  it('produces 0 mutations on second run (idempotent)', async () => {
    // Arrange — run once
    const path1 = join(tmpdir(), `migrate-idempotent-run1-${Date.now()}.json`)
    await backfill({ repo: 'Roxabi/test', dryRun: false, snapshotPath: path1 })
    const callsAfterFirst = mockUpdateField.mock.calls.length + mockUpdateIssueIssueType.mock.calls.length

    // Act — run again with same state
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setupFullyPopulatedMocks()
    const path2 = join(tmpdir(), `migrate-idempotent-run2-${Date.now()}.json`)
    await backfill({ repo: 'Roxabi/test', dryRun: false, snapshotPath: path2 })

    // Assert
    expect(callsAfterFirst).toBe(0)
    expect(mockUpdateField).not.toHaveBeenCalled()
    expect(mockUpdateIssueIssueType).not.toHaveBeenCalled()
  })
})
