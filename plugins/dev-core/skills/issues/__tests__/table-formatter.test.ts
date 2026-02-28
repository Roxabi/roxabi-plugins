import { describe, expect, it } from 'vitest'
import type { RawItem } from '../../shared/types'
import { formatDeps, formatJson, formatTable, pad, sortIssues } from '../lib/table-formatter'
import type { Issue } from '../lib/types'

function makeRawItem(
  overrides: Partial<RawItem['content']> = {},
  fields: Record<string, string> = {}
): RawItem {
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
  })

  describe('sortIssues', () => {
    it('sorts blocking before ready before blocked', () => {
      const items = [
        makeRawItem(
          { number: 1, blockedBy: { nodes: [{ number: 99, state: 'OPEN' }] } },
          { Status: 'Backlog', Priority: 'P0 - Urgent' }
        ),
        makeRawItem({ number: 2 }, { Status: 'Backlog', Priority: 'P0 - Urgent' }),
        makeRawItem(
          { number: 3, blocking: { nodes: [{ number: 1, state: 'OPEN' }] } },
          { Status: 'Backlog', Priority: 'P0 - Urgent' }
        ),
      ]

      const sorted = sortIssues(items)
      expect(sorted.map((i) => i.content.number)).toEqual([3, 2, 1])
    })

    it('sorts by priority within same block status', () => {
      const items = [
        makeRawItem({ number: 1 }, { Status: 'Backlog', Priority: 'P3 - Low' }),
        makeRawItem({ number: 2 }, { Status: 'Backlog', Priority: 'P0 - Urgent' }),
      ]

      const sorted = sortIssues(items)
      expect(sorted.map((i) => i.content.number)).toEqual([2, 1])
    })
  })

  describe('formatTable', () => {
    it('produces header with issue count', () => {
      const items = [
        makeRawItem(
          { number: 1, title: 'First issue' },
          { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' }
        ),
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
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' }
      )
      const child = makeRawItem(
        { number: 11, title: 'Child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' }
      )
      const output = formatTable([parent, child], { sortBy: 'priority', titleLength: 55 })
      // Should contain tree connector character
      expect(output).toContain('#11')
    })

    it('skips children from root list (shown inline)', () => {
      const parent = makeRawItem(
        {
          number: 10,
          title: 'Parent',
          subIssues: { nodes: [{ number: 11, state: 'OPEN', title: 'Child' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'M' }
      )
      const child = makeRawItem(
        { number: 11, title: 'Child', parent: { number: 10, state: 'OPEN' } },
        { Status: 'Backlog', Priority: 'P2 - Medium', Size: 'S' }
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
        { Status: 'In Progress', Priority: 'P0 - Urgent', Size: 'M' }
      )
      const blocked = makeRawItem(
        {
          number: 51,
          title: 'Add login page',
          blockedBy: { nodes: [{ number: 50, state: 'OPEN' }] },
        },
        { Status: 'Backlog', Priority: 'P1 - High', Size: 'S' }
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
      const items = [
        makeRawItem({ number: 1, state: 'OPEN' }, {}),
        makeRawItem({ number: 2, state: 'CLOSED' }, {}),
      ]
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
          {}
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
          {}
        ),
      ]
      const result = JSON.parse(formatJson(items))
      expect(result[0].sub_issues).toEqual([{ number: 2, state: 'OPEN', title: 'Sub' }])
      expect(result[0].parent_issue).toEqual({ number: 99, state: 'OPEN' })
    })
  })
})
