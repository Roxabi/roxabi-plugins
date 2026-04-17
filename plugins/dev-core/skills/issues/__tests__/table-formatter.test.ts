import { describe, expect, it } from 'vitest'
import type { RawItem } from '../../shared/types'
import { formatDeps, formatJson, formatTable, formatTree, pad, sortIssues } from '../lib/table-formatter'
import type { Issue } from '../lib/types'

function makeRawItem(overrides: Partial<RawItem['content']> = {}, fields: Record<string, string> = {}): RawItem {
  return {
    content: {
      number: 1,
      title: 'Test issue',
      state: 'OPEN',
      url: 'https://github.com/test/1',
      subIssues: { nodes: [] },
      parent: null,
      blockedBy: { nodes: [] },
      blocking: { nodes: [] },
      ...overrides,
    },
    fieldValues: {
      nodes: Object.entries(fields).map(([fieldName, value]) => ({
        name: value,
        field: { name: fieldName },
      })),
    },
  }
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    title: 'Test',
    url: 'https://github.com/test/1',
    status: '-',
    size: '-',
    priority: '-',
    blockStatus: 'ready',
    blockedBy: [],
    blocking: [],
    children: [],
    ...overrides,
  }
}

describe('table-formatter', () => {
  describe('pad', () => {
    it('pads short strings with spaces', () => {
      expect(pad('hi', 5)).toBe('hi   ')
    })

    it('truncates long strings', () => {
      expect(pad('hello world', 5)).toBe('hello')
    })

    it('returns exact width strings unchanged', () => {
      expect(pad('hello', 5)).toBe('hello')
    })
  })

  describe('formatDeps', () => {
    it('returns - for no dependencies', () => {
      expect(formatDeps(makeIssue())).toBe('-')
    })

    it('formats blocked-by open as red', () => {
      const issue = makeIssue({
        blockedBy: [{ number: 42, state: 'OPEN' }],
      })
      expect(formatDeps(issue)).toContain('#42')
    })

    it('formats blocked-by closed as green', () => {
      const issue = makeIssue({
        blockedBy: [{ number: 42, state: 'CLOSED' }],
      })
      expect(formatDeps(issue)).toContain('#42')
    })

    it('formats blocking issues', () => {
      const issue = makeIssue({
        blocking: [{ number: 10, state: 'OPEN' }],
      })
      expect(formatDeps(issue)).toContain('#10')
    })

    it('combines multiple dependencies', () => {
      const issue = makeIssue({
        blockedBy: [{ number: 5, state: 'OPEN' }],
        blocking: [{ number: 10, state: 'OPEN' }],
      })
      const deps = formatDeps(issue)
      expect(deps).toContain('#5')
      expect(deps).toContain('#10')
    })

    it('shows all deps when 4 or fewer', () => {
      const issue = makeIssue({
        blockedBy: [
          { number: 1, state: 'OPEN' },
          { number: 2, state: 'OPEN' },
          { number: 3, state: 'OPEN' },
          { number: 4, state: 'OPEN' },
        ],
      })
      const deps = formatDeps(issue)
      expect(deps).toContain('#4')
      expect(deps).not.toContain('[...]')
    })

    it('truncates to 3 with [...] when more than 4 deps', () => {
      const issue = makeIssue({
        blockedBy: [
          { number: 1, state: 'OPEN' },
          { number: 2, state: 'OPEN' },
          { number: 3, state: 'OPEN' },
          { number: 4, state: 'OPEN' },
          { number: 5, state: 'OPEN' },
        ],
      })
      const deps = formatDeps(issue)
      expect(deps).toContain('#1')
      expect(deps).toContain('#2')
      expect(deps).toContain('#3')
      expect(deps).not.toContain('#4')
      expect(deps).toContain('[...]')
    })
  })

  describe('sortIssues', () => {
    it('sorts by priority over parent status (P0 leaf before P1 parent)', () => {
      const items = [
        makeRawItem({ number: 1 }, { Priority: 'P0 - Urgent', Size: 'M' }),
        makeRawItem(
          { number: 2, subIssues: { nodes: [{ number: 10, state: 'OPEN', title: 'child' }] } },
          { Priority: 'P1 - High', Size: 'XL' },
        ),
      ]

      const sorted = sortIssues(items)
      expect(sorted.map((i) => i.content.number)).toEqual([1, 2])
    })

    it('sorts by priority P0 → P3', () => {
      const items = [
        makeRawItem({ number: 1 }, { Priority: 'P3 - Low', Size: 'M' }),
        makeRawItem({ number: 2 }, { Priority: 'P0 - Urgent', Size: 'M' }),
      ]

      const sorted = sortIssues(items)
      expect(sorted.map((i) => i.content.number)).toEqual([2, 1])
    })

    it('sorts by size XL → XS within same priority', () => {
      const items = [
        makeRawItem({ number: 1 }, { Priority: 'P1 - High', Size: 'S' }),
        makeRawItem({ number: 2 }, { Priority: 'P1 - High', Size: 'XL' }),
        makeRawItem({ number: 3 }, { Priority: 'P1 - High', Size: 'M' }),
      ]

      const sorted = sortIssues(items)
      expect(sorted.map((i) => i.content.number)).toEqual([2, 3, 1])
    })
  })

  describe('formatTable', () => {
    it('produces header with issue count', () => {
      const items = [
        makeRawItem({ number: 1, title: 'First issue' }, { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' }),
      ]
      const output = formatTable(items, { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('1 issues')
    })

    it('includes column headers', () => {
      const output = formatTable([], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('Title')
      expect(output).toContain('Status')
      expect(output).toContain('Size')
      expect(output).toContain('Pri')
      expect(output).toContain('Deps')
    })

    it('includes legend', () => {
      const output = formatTable([], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('blocked')
      expect(output).toContain('blocking')
      expect(output).toContain('ready')
    })

    it('renders child issues with tree connectors', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        { number: 11, title: 'Child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' },
      )
      const output = formatTable([parent, child], { sortBy: 'priority', titleLength: 55 })
      // Should contain tree connector character
      expect(output).toContain('#11')
    })

    it('aligns │ after title at the same column for root, children, and grandchildren', () => {
      const tl = 40
      const grandparent = makeRawItem(
        {
          number: 10,
          title: 'A'.repeat(tl + 10),
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'B'.repeat(tl + 10) }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        {
          number: 11,
          title: 'B'.repeat(tl + 10),
          parent: { number: 10, state: 'OPEN' },
          subIssues: { nodes: [{ number: 12, state: 'OPEN', title: 'C'.repeat(tl + 10) }] },
        },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' },
      )
      const grandchild = makeRawItem(
        { number: 12, title: 'C'.repeat(tl + 10), parent: { number: 11, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'XS' },
      )
      const output = formatTable([grandparent, child, grandchild], { sortBy: 'priority', titleLength: tl })
      const lines = output.split('\n')
      // Collect column positions of the first │ that ends the title column (after the row number)
      const titleEndPositions = lines
        .filter((l) => l.includes('│') && (l.includes('#10') || l.includes('#11') || l.includes('#12')))
        .map((l) => {
          // The title-ending │ is always the 2nd │ in each data row
          const first = l.indexOf('│')
          return l.indexOf('│', first + 1)
        })
      // All rows must have their title-column │ at the same position
      expect(new Set(titleEndPositions).size).toBe(1)
    })

    it('renders grandchildren recursively under their parent child', () => {
      const grandparent = makeRawItem(
        {
          number: 10,
          title: 'Grandparent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        {
          number: 11,
          title: 'Child',
          parent: { number: 10, state: 'OPEN' },
          subIssues: { nodes: [{ number: 12, state: 'OPEN', title: 'Grandchild' }] },
        },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' },
      )
      const grandchild = makeRawItem(
        { number: 12, title: 'Grandchild', parent: { number: 11, state: 'OPEN' } },
        { Status: 'In Progress', Priority: 'P2 - Medium', Size: 'XS' },
      )
      const output = formatTable([grandparent, child, grandchild], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('#12')
      expect(output).toContain('1 issues') // only grandparent is root
    })

    it('collapses closed children into a done summary row', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: {
            nodes: [
              { number: 11, state: 'OPEN', title: 'Open child' },
              { number: 12, state: 'CLOSED', title: 'Done child 1' },
              { number: 13, state: 'CLOSED', title: 'Done child 2' },
            ],
          },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const openChild = makeRawItem(
        { number: 11, title: 'Open child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'In Progress', Priority: 'P2 - Medium', Size: 'S' },
      )
      const output = formatTable([parent, openChild], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('#11')
      expect(output).not.toContain('#12')
      expect(output).not.toContain('#13')
      expect(output).toContain('2 done')
    })

    it('skips children from root list (shown inline)', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        { number: 11, title: 'Child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' },
      )
      const output = formatTable([parent, child], { sortBy: 'priority', titleLength: 55 })
      // Count should show 1 root issue, not 2
      expect(output).toContain('1 issues')
    })

    it('should include Chains section with dependency arrows when blocking relationships exist', () => {
      // Arrange
      const blocker = makeRawItem(
        {
          number: 50,
          title: 'Setup auth module',
          blocking: { nodes: [{ number: 51, state: 'OPEN' }] },
        },
        { Status: 'In Progress', Priority: 'P0 - Urgent', Size: 'M' },
      )
      const blocked = makeRawItem(
        {
          number: 51,
          title: 'Add login page',
          blockedBy: { nodes: [{ number: 50, state: 'OPEN' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'S' },
      )

      // Act
      const output = formatTable([blocker, blocked], { sortBy: 'priority', titleLength: 55 })

      // Assert
      expect(output).toContain('Chains:')
      expect(output).toContain('#50')
      expect(output).toContain('#51')
      expect(output).toMatch(/#50.*──►.*#51/)
    })
  })

  describe('formatJson', () => {
    it('filters to open issues only', () => {
      const items = [makeRawItem({ number: 1, state: 'OPEN' }, {}), makeRawItem({ number: 2, state: 'CLOSED' }, {})]
      const result = JSON.parse(formatJson(items))
      expect(result).toHaveLength(1)
      expect(result[0].number).toBe(1)
    })

    it('includes dependency breakdown', () => {
      const items = [
        makeRawItem(
          {
            number: 1,
            blockedBy: {
              nodes: [
                { number: 5, state: 'OPEN' },
                { number: 6, state: 'CLOSED' },
              ],
            },
          },
          {},
        ),
      ]
      const result = JSON.parse(formatJson(items))
      expect(result[0].blocked_by_open).toEqual([5])
      expect(result[0].blocked_by_closed).toEqual([6])
    })

    it('includes sub_issues and parent_issue', () => {
      const items = [
        makeRawItem(
          {
            number: 1,
            subIssues: { nodes: [{ number: 2, state: 'OPEN', title: 'Sub' }] },
            parent: { number: 99, state: 'OPEN' },
          },
          {},
        ),
      ]
      const result = JSON.parse(formatJson(items))
      expect(result[0].sub_issues).toEqual([{ number: 2, state: 'OPEN', title: 'Sub' }])
      expect(result[0].parent_issue).toEqual({ number: 99, state: 'OPEN' })
    })
  })

  describe('formatTree', () => {
    it('includes issue count header with (tree) label', () => {
      const items = [
        makeRawItem({ number: 1, title: 'Root issue' }, { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' }),
      ]
      const output = formatTree(items, { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('1 issues (tree)')
    })

    it('produces same columnar format as formatTable', () => {
      const items = [
        makeRawItem({ number: 42, title: 'My epic' }, { Status: 'Backlog', Priority: 'P1 - High', Size: 'XL' }),
      ]
      const treeOutput = formatTree(items, { sortBy: 'priority', titleLength: 55 })
      const tableOutput = formatTable(items, { sortBy: 'priority', titleLength: 55 })
      // Only difference is the "(tree)" label
      expect(treeOutput).toBe(tableOutput.replace(/(\d+ issues)/, '$1 (tree)'))
    })

    it('includes column headers', () => {
      const output = formatTree([], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('Title')
      expect(output).toContain('Status')
      expect(output).toContain('Size')
      expect(output).toContain('Pri')
      expect(output).toContain('Deps')
    })

    it('shows children with tree connectors', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        { number: 11, title: 'Child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'In Progress', Priority: 'P2 - Medium', Size: 'S' },
      )
      const output = formatTree([parent, child], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('#10')
      expect(output).toContain('#11')
      expect(output).toContain('└')
    })

    it('shows grandchildren recursively', () => {
      const grandparent = makeRawItem(
        {
          number: 10,
          title: 'Grandparent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const child = makeRawItem(
        {
          number: 11,
          title: 'Child',
          parent: { number: 10, state: 'OPEN' },
          subIssues: { nodes: [{ number: 12, state: 'OPEN', title: 'Grandchild' }] },
        },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' },
      )
      const grandchild = makeRawItem(
        { number: 12, title: 'Grandchild', parent: { number: 11, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'XS' },
      )
      const output = formatTree([grandparent, child, grandchild], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('#10')
      expect(output).toContain('#11')
      expect(output).toContain('#12')
    })

    it('summarises closed children as done count', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: {
            nodes: [
              { number: 11, state: 'OPEN', title: 'Open' },
              { number: 12, state: 'CLOSED', title: 'Done' },
            ],
          },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' },
      )
      const openChild = makeRawItem(
        { number: 11, title: 'Open', parent: { number: 10, state: 'OPEN' } },
        { Status: 'In Progress', Priority: 'P2 - Medium', Size: 'S' },
      )
      const output = formatTree([parent, openChild], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('#11')
      expect(output).not.toContain('#12')
      expect(output).toContain('1 done')
    })

    it('includes legend', () => {
      const output = formatTree([], { sortBy: 'priority', titleLength: 55 })
      expect(output).toContain('blocked')
      expect(output).toContain('blocking')
      expect(output).toContain('ready')
    })
  })
})
