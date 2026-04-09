import { describe, expect, it } from 'vitest'
import {
  buildCols,
  buildEpicData,
  type EpicData,
  type EpicRow,
  isActive,
  lane,
  nextIssue,
  openCount,
  pad,
  parseBlockedBy,
  progressBar,
  renderCols,
  SEP,
  stripType,
  trow,
  trunc,
} from '../lib/digest-helpers'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkEpicData(overrides: Partial<EpicData> = {}): EpicData {
  return {
    number: 1,
    title: 'Test epic',
    state: 'OPEN',
    blockedBy: [],
    leaves: [],
    subEpics: [],
    rawSubEpics: [],
    ...overrides,
  }
}

function mkRow(overrides: { data?: Partial<EpicData> } & Omit<Partial<EpicRow>, 'data'> = {}): EpicRow {
  const { data: dataOverrides, ...rest } = overrides
  const data = mkEpicData(dataOverrides)
  return {
    number: data.number,
    title: data.title,
    state: data.state,
    progress: { closed: 0, total: 0 },
    depth: 0,
    ...rest,
    data,
  }
}

// ─── parseBlockedBy ───────────────────────────────────────────────────────────

describe('parseBlockedBy', () => {
  it('returns empty for null body', () => {
    expect(parseBlockedBy(null)).toEqual([])
  })

  it('returns empty for body without blocked section', () => {
    expect(parseBlockedBy('Just some text\n## Other section\n#42')).toEqual([])
  })

  it('parses issue numbers from blocked by section', () => {
    const body = '## Description\nSome text\n## Blocked by\n- #10\n- #20 and #30\n## Next section'
    expect(parseBlockedBy(body)).toEqual([10, 20, 30])
  })

  it('stops at the next heading', () => {
    const body = '## Blocked by\n#1\n## Other\n#2'
    expect(parseBlockedBy(body)).toEqual([1])
  })

  it('is case-insensitive', () => {
    expect(parseBlockedBy('## BLOCKED BY\n#5')).toEqual([5])
  })
})

// ─── progressBar ──────────────────────────────────────────────────────────────

describe('progressBar', () => {
  it('returns empty bar for total=0', () => {
    expect(progressBar(0, 0)).toBe('░░░░░')
  })

  it('returns full bar for all closed', () => {
    expect(progressBar(10, 10)).toBe('█████')
  })

  it('returns partial bar', () => {
    expect(progressBar(3, 5)).toBe('███░░')
  })

  it('returns single block for 1/5', () => {
    expect(progressBar(1, 5)).toBe('█░░░░')
  })
})

// ─── pad ──────────────────────────────────────────────────────────────────────

describe('pad', () => {
  it('pads right by default', () => {
    expect(pad('hi', 5)).toBe('hi   ')
  })

  it('pads left', () => {
    expect(pad('hi', 5, 'r')).toBe('   hi')
  })

  it('pads center', () => {
    expect(pad('hi', 6, 'c')).toBe('  hi  ')
  })

  it('returns unchanged if already long enough', () => {
    expect(pad('hello', 3)).toBe('hello')
  })
})

// ─── trunc ────────────────────────────────────────────────────────────────────

describe('trunc', () => {
  it('returns unchanged if within limit', () => {
    expect(trunc('short', 10)).toBe('short')
  })

  it('truncates with ellipsis', () => {
    expect(trunc('a long title here', 10)).toBe('a long ti…')
  })

  it('returns exact length unchanged', () => {
    expect(trunc('exact', 5)).toBe('exact')
  })
})

// ─── stripType ────────────────────────────────────────────────────────────────

describe('stripType', () => {
  it('strips feat(scope): prefix', () => {
    expect(stripType('feat(core): add feature')).toBe('add feature')
  })

  it('strips fix: prefix', () => {
    expect(stripType('fix: broken thing')).toBe('broken thing')
  })

  it('leaves plain titles unchanged', () => {
    expect(stripType('just a title')).toBe('just a title')
  })

  it('is case-insensitive', () => {
    expect(stripType('FEAT(ui): button')).toBe('button')
  })
})

// ─── lane ─────────────────────────────────────────────────────────────────────

describe('lane', () => {
  it('returns A for infra titles', () => {
    expect(lane('ops(infra): setup docker')).toBe('A')
  })

  it('returns A for CI titles', () => {
    expect(lane('fix ci pipeline')).toBe('A')
  })

  it('returns C for brand titles', () => {
    expect(lane('brand exploration v23')).toBe('C')
  })

  it('returns C for avatar titles', () => {
    expect(lane('avatar generation pipeline')).toBe('C')
  })

  it('returns B for everything else', () => {
    expect(lane('add user profile page')).toBe('B')
  })
})

// ─── isActive ─────────────────────────────────────────────────────────────────

describe('isActive', () => {
  it('returns true when some issues closed', () => {
    expect(isActive(mkRow({ progress: { closed: 2, total: 5 } }))).toBe(true)
  })

  it('returns false when none closed', () => {
    expect(isActive(mkRow({ progress: { closed: 0, total: 5 } }))).toBe(false)
  })
})

// ─── openCount ────────────────────────────────────────────────────────────────

describe('openCount', () => {
  it('counts open leaves', () => {
    const row = mkRow({
      data: {
        leaves: [
          { number: 1, title: 'a', state: 'OPEN', blockedBy: [] },
          { number: 2, title: 'b', state: 'CLOSED', blockedBy: [] },
          { number: 3, title: 'c', state: 'OPEN', blockedBy: [] },
        ],
      },
    })
    expect(openCount(row)).toBe(2)
  })
})

// ─── nextIssue ────────────────────────────────────────────────────────────────

describe('nextIssue', () => {
  it('returns done when all closed', () => {
    const row = mkRow({
      data: { leaves: [{ number: 1, title: 'a', state: 'CLOSED', blockedBy: [] }] },
    })
    expect(nextIssue(row)).toBe('✓ done')
  })

  it('picks first unblocked open issue', () => {
    const row = mkRow({
      data: {
        leaves: [
          { number: 10, title: 'blocked one', state: 'OPEN', blockedBy: [99] },
          { number: 11, title: 'free one', state: 'OPEN', blockedBy: [] },
        ],
      },
    })
    expect(nextIssue(row)).toContain('#11')
  })

  it('falls back to first open if all blocked', () => {
    const row = mkRow({
      data: {
        leaves: [{ number: 10, title: 'only one', state: 'OPEN', blockedBy: [99] }],
      },
    })
    expect(nextIssue(row)).toContain('#10')
  })
})

// ─── trow ─────────────────────────────────────────────────────────────────────

describe('trow', () => {
  it('produces padded columns with separators', () => {
    const result = trow('#1', 'Epic title', '███░░ 3/5', '2', '#10 next')
    expect(result).toContain(SEP)
    expect(result).toContain('#1')
    expect(result).toContain('Epic title')
  })
})

// ─── buildCols ────────────────────────────────────────────────────────────────

describe('buildCols', () => {
  it('routes items to lanes by title', () => {
    const leafMap = new Map([
      [1, { title: 'setup docker infra', blockedBy: [] }],
      [2, { title: 'add user page', blockedBy: [] }],
      [3, { title: 'brand avatar v23', blockedBy: [] }],
    ])
    const nums = new Set([1, 2, 3])
    const cols = buildCols(leafMap, nums)
    expect(cols.A).toHaveLength(1)
    expect(cols.B).toHaveLength(1)
    expect(cols.C).toHaveLength(1)
  })

  it('marks chained items when prevNums overlap with blockedBy', () => {
    const leafMap = new Map([[2, { title: 'follow-up task', blockedBy: [1] }]])
    const cols = buildCols(leafMap, new Set([2]), new Set([1]))
    expect(cols.B[0].chained).toBe(true)
  })
})

// ─── renderCols ───────────────────────────────────────────────────────────────

describe('renderCols', () => {
  it('returns empty for empty cols', () => {
    expect(renderCols('1', { A: [], B: [], C: [] })).toEqual([])
  })

  it('renders label on first row only', () => {
    const cols = {
      A: [
        { label: '#1 task a', chained: false },
        { label: '#2 task b', chained: false },
      ],
      B: [],
      C: [],
    }
    const lines = renderCols('P1', cols, { A: 20, B: 20, C: 20 })
    expect(lines[0]).toContain('P1')
    expect(lines[1]).not.toMatch(/P1/)
  })
})

// ─── buildEpicData ────────────────────────────────────────────────────────────

describe('buildEpicData', () => {
  it('extracts leaves from flat children', () => {
    const data = {
      number: 1,
      title: 'Epic',
      state: 'OPEN',
      body: null,
      subIssues: {
        nodes: [
          { number: 10, title: 'Task A', state: 'OPEN', body: null, subIssues: { nodes: [] } },
          { number: 11, title: 'Task B', state: 'CLOSED', body: null, subIssues: { nodes: [] } },
        ],
      },
    }
    const result = buildEpicData(data, new Map())
    expect(result.leaves).toHaveLength(2)
    expect(result.subEpics).toHaveLength(0)
  })

  it('flattens grandchildren from sub-epics', () => {
    const data = {
      number: 1,
      title: 'Epic',
      state: 'OPEN',
      body: null,
      subIssues: {
        nodes: [
          {
            number: 10,
            title: 'Sub-epic',
            state: 'OPEN',
            body: null,
            subIssues: {
              nodes: [
                { number: 20, title: 'GC 1', state: 'OPEN', body: '## Blocked by\n#10' },
                { number: 21, title: 'GC 2', state: 'CLOSED', body: null },
              ],
            },
          },
        ],
      },
    }
    const result = buildEpicData(data, new Map())
    expect(result.leaves).toHaveLength(2)
    expect(result.subEpics).toEqual([10])
    expect(result.leaves[0].blockedBy).toEqual([10])
  })
})
