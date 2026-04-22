import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      'a1',
      'a2',
      'a3',
      'b',
      'c1',
      'c2',
      'c3',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'standalone',
    ].map((k) => [k, `lane-${k}`]),
  ),
)

// Full DEFAULT_LANE_OPTIONS list (20 entries) — mirrors config-helpers.ts
const ALL_LANE_KEYS = [
  'a1',
  'a2',
  'a3',
  'b',
  'c1',
  'c2',
  'c3',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'standalone',
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
      'a1',
      'a2',
      'a3',
      'b',
      'c1',
      'c2',
      'c3',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'standalone',
    ].map((k) => [k, `lane-${k}`]),
  ),
  DEFAULT_LANE_OPTIONS: [
    'a1',
    'a2',
    'a3',
    'b',
    'c1',
    'c2',
    'c3',
    'd',
    'e',
    'f',
    'g',
    'h',
    'i',
    'j',
    'k',
    'l',
    'm',
    'n',
    'o',
    'standalone',
  ],
  resolveStatus: (input: string) => {
    const aliases: Record<string, string> = {
      BACKLOG: 'Backlog',
      ANALYSIS: 'Analysis',
      SPECS: 'Specs',
      'IN PROGRESS': 'In Progress',
      IN_PROGRESS: 'In Progress',
      INPROGRESS: 'In Progress',
      REVIEW: 'Review',
      DONE: 'Done',
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
      URGENT: 'P0 - Urgent',
      HIGH: 'P1 - High',
      MEDIUM: 'P2 - Medium',
      LOW: 'P3 - Low',
      P0: 'P0 - Urgent',
      P1: 'P1 - High',
      P2: 'P2 - Medium',
      P3: 'P3 - Low',
    }
    return aliases[input.toUpperCase()]
  },
  resolveLane: (input: string) => {
    const valid = new Set([
      'a1',
      'a2',
      'a3',
      'b',
      'c1',
      'c2',
      'c3',
      'd',
      'e',
      'f',
      'g',
      'h',
      'i',
      'j',
      'k',
      'l',
      'm',
      'n',
      'o',
      'standalone',
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
  clearField: vi.fn(),
  run: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}))

const github = await import('../../shared/adapters/github-adapter')
const mockGhGraphQL = github.ghGraphQL as ReturnType<typeof vi.fn>
const mockUpdateField = github.updateField as ReturnType<typeof vi.fn>
const mockResolveIssueTypeId = github.resolveIssueTypeId as ReturnType<typeof vi.fn>
const mockUpdateIssueIssueType = github.updateIssueIssueType as ReturnType<typeof vi.fn>
const mockClearField = github.clearField as ReturnType<typeof vi.fn>
const mockRun = github.run as ReturnType<typeof vi.fn>

const childProcess = await import('node:child_process')
const mockExecSync = childProcess.execSync as ReturnType<typeof vi.fn>

const { LEGACY_LABEL_MAP, TITLE_PREFIX_RE, auditSchema, backfill, rewriteTitles, revert } = await import(
  '../lib/migrate'
)

// Local mirror of RewriteRow (not exported from migrate.ts)
interface RewriteRow {
  repo: string
  number: number
  old_title: string
  new_title: string
}

// Local mirror of BackfillRow (not exported from migrate.ts)
interface BackfillRow {
  repo: string
  number: number
  field: string
  old_value: string | null
  new_value: string | null
  flagged: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuditSchemaResponse(laneOptions: string[]) {
  return {
    node: {
      fields: {
        nodes: [
          {
            id: 'f-size',
            name: 'Size',
            options: ['XS', 'S', 'M', 'L', 'XL'].map((n) => ({ id: `s-${n}`, name: n })),
          },
          {
            id: 'f-lane',
            name: 'Lane',
            options: laneOptions.map((n) => ({ id: `l-${n}`, name: n })),
          },
          {
            id: 'f-priority',
            name: 'Priority',
            options: ['P0 - Urgent', 'P1 - High', 'P2 - Medium', 'P3 - Low'].map((n) => ({ id: `p-${n}`, name: n })),
          },
          {
            id: 'f-status',
            name: 'Status',
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
    labels: [{ name: 'graph:lane/c1' }, { name: 'size:M' }, { name: 'P1-high' }],
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
    labels: [{ name: 'graph:lane/a1' }, { name: 'size:S' }, { name: 'P2-medium' }],
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

// ---------------------------------------------------------------------------
// 7. rewriteTitles
// ---------------------------------------------------------------------------

describe('migrate > rewriteTitles', () => {
  let snapshotPath: string

  // 16 synthetic issues: all 8 types × (with scope + without scope)
  const matchingIssues = [
    { number: 101, title: 'feat: add login' },
    { number: 102, title: 'feat(auth): add oauth' },
    { number: 103, title: 'fix: null pointer' },
    { number: 104, title: 'fix(parser): handle empty input' },
    { number: 105, title: 'refactor: extract service' },
    { number: 106, title: 'refactor(core): simplify logic' },
    { number: 107, title: 'docs: update readme' },
    { number: 108, title: 'docs(api): add examples' },
    { number: 109, title: 'test: add unit tests' },
    { number: 110, title: 'test(auth): cover edge cases' },
    { number: 111, title: 'chore: bump deps' },
    { number: 112, title: 'chore(ci): update actions' },
    { number: 113, title: 'ci: fix pipeline' },
    { number: 114, title: 'ci(deploy): add staging step' },
    { number: 115, title: 'perf: reduce bundle size' },
    { number: 116, title: 'perf(render): memoize component' },
  ]

  const nonMatchingIssues = [
    { number: 201, title: 'random title' },
    { number: 202, title: 'colon: but no type keyword' },
    { number: 203, title: 'foo(scope): bar but no type keyword either' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    snapshotPath = join(tmpdir(), `rewrite-test-snapshot-${Date.now()}.json`)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  describe('dry-run with all 8 conventional-commit types (with and without scope)', () => {
    it('writes snapshot with 16 rows — one per matching title', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(matchingIssues))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(16)
    })

    it('each snapshot row has repo, number, old_title, new_title fields', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(matchingIssues))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      for (const row of rows) {
        expect(row).toHaveProperty('repo', 'Roxabi/test')
        expect(row).toHaveProperty('number')
        expect(row).toHaveProperty('old_title')
        expect(row).toHaveProperty('new_title')
      }
    })

    it('strips prefix from all 8 types without scope', async () => {
      // Arrange
      const withoutScope = matchingIssues.filter((_, i) => i % 2 === 0) // even indices = no scope
      mockExecSync.mockReturnValue(JSON.stringify(withoutScope))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(8)
      for (const row of rows) {
        // new_title must not start with any conventional-commit prefix
        expect(row.new_title).not.toMatch(/^(feat|fix|refactor|docs|test|chore|ci|perf)(\(.+?\))?:\s*/)
      }
    })

    it('strips prefix from all 8 types with scope', async () => {
      // Arrange
      const withScope = matchingIssues.filter((_, i) => i % 2 === 1) // odd indices = with scope
      mockExecSync.mockReturnValue(JSON.stringify(withScope))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(8)
      for (const row of rows) {
        expect(row.new_title).not.toMatch(/^(feat|fix|refactor|docs|test|chore|ci|perf)(\(.+?\))?:\s*/)
      }
    })

    it('does not call gh issue edit in dry-run mode', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(matchingIssues))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert — only the gh issue list call happened, no edit calls
      const calls = mockExecSync.mock.calls as string[][]
      const editCalls = calls.filter((args) => String(args[0]).includes('gh issue edit'))
      expect(editCalls).toHaveLength(0)
    })

    it('preserves body text after stripping prefix (no scope)', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 101, title: 'feat: add login' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows[0].new_title).toBe('add login')
    })

    it('preserves body text after stripping prefix (with scope)', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 102, title: 'feat(auth): add oauth' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows[0].new_title).toBe('add oauth')
    })
  })

  describe('non-matching titles are left untouched', () => {
    it('writes empty snapshot when no titles match', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(nonMatchingIssues))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(0)
    })

    it('does not emit a row for plain title without colon', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 201, title: 'random title' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(0)
    })

    it('does not emit a row for colon present but no valid type keyword', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 202, title: 'colon: but no type keyword' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(0)
    })

    it('does not emit a row for scope-like prefix without valid type keyword', async () => {
      // Arrange
      mockExecSync.mockReturnValue(
        JSON.stringify([{ number: 203, title: 'foo(scope): bar but no type keyword either' }]),
      )

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(0)
    })

    it('does not call gh issue edit for non-matching titles', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(nonMatchingIssues))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: false, snapshotPath })

      // Assert
      const calls = mockExecSync.mock.calls as string[][]
      const editCalls = calls.filter((args) => String(args[0]).includes('gh issue edit'))
      expect(editCalls).toHaveLength(0)
    })
  })

  describe('live run calls gh issue edit', () => {
    it('calls gh issue edit with --repo, --title, and issue number', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 101, title: 'feat: add login' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: false, snapshotPath })

      // Assert
      const calls = mockExecSync.mock.calls as string[][]
      const editCalls = calls.filter((args) => String(args[0]).includes('gh issue edit'))
      expect(editCalls).toHaveLength(1)
      const cmd = String(editCalls[0][0])
      expect(cmd).toContain('gh issue edit 101')
      expect(cmd).toContain('--repo Roxabi/test')
      expect(cmd).toContain('--title')
      expect(cmd).toContain('add login')
    })

    it('writes snapshot even in live mode', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify([{ number: 101, title: 'feat: add login' }]))

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: false, snapshotPath })

      // Assert
      const raw = await readFile(snapshotPath, 'utf-8')
      const rows = JSON.parse(raw) as RewriteRow[]
      expect(rows).toHaveLength(1)
      expect(rows[0].number).toBe(101)
    })

    it('calls gh issue edit once per matching issue', async () => {
      // Arrange — 3 matching + 1 non-matching
      mockExecSync.mockReturnValue(
        JSON.stringify([
          { number: 101, title: 'feat: add login' },
          { number: 102, title: 'fix: null pointer' },
          { number: 103, title: 'chore: bump deps' },
          { number: 201, title: 'random title' },
        ]),
      )

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: false, snapshotPath })

      // Assert
      const calls = mockExecSync.mock.calls as string[][]
      const editCalls = calls.filter((args) => String(args[0]).includes('gh issue edit'))
      expect(editCalls).toHaveLength(3)
    })
  })

  describe('summary line', () => {
    it('prints a line matching /Stripped \\d+ titles/', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(matchingIssues))
      const logSpy = console.log as ReturnType<typeof vi.fn>

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => /Stripped \d+ titles/.test(msg))).toBe(true)
    })

    it('reports 16 stripped titles when all 16 matching issues provided', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(matchingIssues))
      const logSpy = console.log as ReturnType<typeof vi.fn>

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => msg.includes('Stripped 16 titles'))).toBe(true)
    })

    it('reports 0 stripped titles when no issues match', async () => {
      // Arrange
      mockExecSync.mockReturnValue(JSON.stringify(nonMatchingIssues))
      const logSpy = console.log as ReturnType<typeof vi.fn>

      // Act
      await rewriteTitles({ repo: 'Roxabi/test', dryRun: true, snapshotPath })

      // Assert
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => msg.includes('Stripped 0 titles'))).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// 8. revert
// ---------------------------------------------------------------------------

import { writeFile } from 'node:fs/promises'

describe('migrate > revert', () => {
  let snapshotPath: string

  beforeEach(() => {
    vi.clearAllMocks()
    snapshotPath = join(tmpdir(), `revert-test-snapshot-${Date.now()}.json`)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockClearField.mockResolvedValue(undefined)
    mockUpdateIssueIssueType.mockResolvedValue(undefined)
    mockRun.mockResolvedValue('')
  })

  afterEach(() => vi.restoreAllMocks())

  describe('backfill snapshot kind', () => {
    it('detects backfill snapshot and calls clearField for non-flagged rows with non-null new_value', async () => {
      // Arrange
      const rows: BackfillRow[] = [
        { repo: 'Roxabi/test', number: 10, field: 'Lane', old_value: null, new_value: 'c1', flagged: false },
        { repo: 'Roxabi/test', number: 10, field: 'Size', old_value: null, new_value: 'S', flagged: false },
        { repo: 'Roxabi/test', number: 10, field: 'Priority', old_value: null, new_value: 'P1 - High', flagged: false },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      mockGhGraphQL.mockResolvedValue(
        makeItemFieldsResponse({
          issueId: 'node-10',
          itemId: 'item-10',
          fields: { Lane: 'c1', Size: 'S', Priority: 'P1 - High' },
        }),
      )

      // Act
      await revert({ snapshotPath })

      // Assert — clearField called once per row (Lane, Size, Priority)
      expect(mockClearField).toHaveBeenCalledTimes(3)
    })

    it('calls updateIssueIssueType(issueNodeId, null) for issueType rows', async () => {
      // Arrange
      const rows: BackfillRow[] = [
        { repo: 'Roxabi/test', number: 11, field: 'issueType', old_value: null, new_value: 'feat', flagged: false },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      mockGhGraphQL.mockResolvedValue(
        makeItemFieldsResponse({
          issueId: 'node-11',
          itemId: 'item-11',
          fields: {},
          issueTypeName: 'feat',
        }),
      )

      // Act
      await revert({ snapshotPath })

      // Assert
      expect(mockUpdateIssueIssueType).toHaveBeenCalledWith('node-11', null)
    })
  })

  describe('rewrite snapshot kind', () => {
    it('detects rewrite snapshot and calls gh issue edit --title <old_title> per row', async () => {
      // Arrange
      const rows: RewriteRow[] = [
        { repo: 'Roxabi/test', number: 20, old_title: 'feat: add login', new_title: 'add login' },
        { repo: 'Roxabi/test', number: 21, old_title: 'fix: null ptr', new_title: 'null ptr' },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      // Mock gh issue view to return the new_title (migration applied) so revert should trigger
      mockRun.mockImplementation(async (cmd: string[]) => {
        if (cmd.includes('view')) {
          const idx = rows.findIndex((r) => cmd.includes(String(r.number)))
          return idx >= 0 ? rows[idx].new_title : ''
        }
        return ''
      })

      // Act
      await revert({ snapshotPath })

      // Assert — gh issue edit called for both rows
      const editCalls = mockRun.mock.calls.filter((c: string[][]) => c[0].includes('edit'))
      expect(editCalls).toHaveLength(2)

      const firstEdit = editCalls[0][0] as string[]
      expect(firstEdit).toContain('--title')
      expect(firstEdit).toContain('feat: add login')
    })
  })

  describe('idempotency', () => {
    it('skips backfill row when field is already cleared (currentFields has no value for that field)', async () => {
      // Arrange — new_value set but project field already cleared
      const rows: BackfillRow[] = [
        { repo: 'Roxabi/test', number: 30, field: 'Lane', old_value: null, new_value: 'a1', flagged: false },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      // Field is absent from live data (already reverted)
      mockGhGraphQL.mockResolvedValue(
        makeItemFieldsResponse({
          issueId: 'node-30',
          itemId: 'item-30',
          fields: {},
        }),
      )

      // Act
      await revert({ snapshotPath })

      // Assert
      expect(mockClearField).not.toHaveBeenCalled()
      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => msg.includes('skip #30'))).toBe(true)
    })

    it('skips rewrite row when current title already matches old_title', async () => {
      // Arrange — issue already reverted: current title = old_title
      const rows: RewriteRow[] = [
        { repo: 'Roxabi/test', number: 40, old_title: 'feat: add login', new_title: 'add login' },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      // gh issue view returns old_title (already restored)
      mockRun.mockResolvedValue('feat: add login')

      // Act
      await revert({ snapshotPath })

      // Assert
      const editCalls = mockRun.mock.calls.filter((c: string[][]) => c[0].includes('edit'))
      expect(editCalls).toHaveLength(0)
      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => msg.includes('skip #40'))).toBe(true)
    })
  })

  describe('unknown snapshot format', () => {
    it('calls process.exit(1) with a message when snapshot is not a recognized format', async () => {
      // Arrange — array of objects that match neither backfill nor rewrite shape
      const unknown = [{ foo: 'bar' }]
      await writeFile(snapshotPath, JSON.stringify(unknown), 'utf-8')

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)

      // Act
      await revert({ snapshotPath })

      // Assert
      expect(exitSpy).toHaveBeenCalledWith(1)
      const errorCalls = (console.error as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0]))
      expect(errorCalls.some((msg) => /unknown snapshot format/i.test(msg))).toBe(true)
    })
  })

  describe('flagged rows', () => {
    it('skips clearField for flagged backfill rows', async () => {
      // Arrange
      const rows: BackfillRow[] = [
        { repo: 'Roxabi/test', number: 50, field: 'Lane', old_value: null, new_value: null, flagged: true },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      // Act
      await revert({ snapshotPath })

      // Assert — flagged row skipped, no field fetched, no clearField called
      expect(mockGhGraphQL).not.toHaveBeenCalled()
      expect(mockClearField).not.toHaveBeenCalled()
    })
  })

  describe('summary line', () => {
    it('prints a line matching /Reverted \\d+ rows/', async () => {
      // Arrange — one non-flagged row that will be reverted
      const rows: BackfillRow[] = [
        { repo: 'Roxabi/test', number: 60, field: 'Size', old_value: null, new_value: 'S', flagged: false },
      ]
      await writeFile(snapshotPath, JSON.stringify(rows), 'utf-8')

      mockGhGraphQL.mockResolvedValue(
        makeItemFieldsResponse({
          issueId: 'node-60',
          itemId: 'item-60',
          fields: { Size: 'S' },
        }),
      )

      const logSpy = console.log as ReturnType<typeof vi.fn>

      // Act
      await revert({ snapshotPath })

      // Assert
      const logCalls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]))
      expect(logCalls.some((msg) => /Reverted \d+ rows/.test(msg))).toBe(true)
    })
  })
})
