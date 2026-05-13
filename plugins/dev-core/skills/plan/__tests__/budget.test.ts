import { describe, expect, it } from 'vitest'
import { classifyTask, computeBudget, renderBudgetTable, SPLIT_THRESHOLD } from '../lib/budget'

describe('budget classifier', () => {
  describe('classifyTask', () => {
    it('trivial: 1 item → 2 ops (rounded mid 1.5)', () => {
      const row = classifyTask({ name: 'Fix typo', items: 1, costClass: 'trivial' })
      expect(row.estimatedOps).toBe(2)
      expect(row.mustSplit).toBe(false)
    })

    it('bounded: 3 items → 8 ops (3 * 2.5 = 7.5 → 8)', () => {
      const row = classifyTask({ name: 'Edit config files', items: 3, costClass: 'bounded' })
      expect(row.estimatedOps).toBe(8)
      expect(row.mustSplit).toBe(false)
    })

    it('judgmental: 6 items → 30 ops (6 * 5)', () => {
      const row = classifyTask({ name: 'Review route handlers', items: 6, costClass: 'judgmental' })
      expect(row.estimatedOps).toBe(30)
      expect(row.mustSplit).toBe(false)
    })

    it('exploratory: 5 items → 58 ops (5 * 11.5 = 57.5 → 58) — exceeds threshold', () => {
      const row = classifyTask({ name: 'Audit cross-file deps', items: 5, costClass: 'exploratory' })
      expect(row.estimatedOps).toBe(58)
      expect(row.mustSplit).toBe(true)
    })

    it('mustSplit is false at exactly the threshold', () => {
      // judgmental: 10 items * 5 mid = 50 — NOT > 50, no split
      const row = classifyTask({ name: 'Exactly at threshold', items: 10, costClass: 'judgmental' })
      expect(row.estimatedOps).toBe(50)
      expect(row.mustSplit).toBe(false)
    })

    it('mustSplit is true one item above the threshold boundary', () => {
      // judgmental: 11 items * 5 = 55 — > 50, split required
      const row = classifyTask({ name: 'Just over threshold', items: 11, costClass: 'judgmental' })
      expect(row.estimatedOps).toBe(55)
      expect(row.mustSplit).toBe(true)
    })

    it('preserves name and items in output', () => {
      const row = classifyTask({ name: 'My task', items: 4, costClass: 'bounded' })
      expect(row.name).toBe('My task')
      expect(row.items).toBe(4)
      expect(row.costClass).toBe('bounded')
    })
  })

  describe('computeBudget', () => {
    it('totals ops across all tasks', () => {
      const { rows, totalOps } = computeBudget([
        { name: 'T1', items: 2, costClass: 'trivial' }, // 2 * 1.5 = 3 → 3
        { name: 'T2', items: 4, costClass: 'bounded' }, // 4 * 2.5 = 10
      ])
      expect(rows).toHaveLength(2)
      expect(totalOps).toBe(rows.reduce((s, r) => s + r.estimatedOps, 0))
    })

    it('returns empty rows and 0 total for empty input', () => {
      const { rows, totalOps } = computeBudget([])
      expect(rows).toHaveLength(0)
      expect(totalOps).toBe(0)
    })

    it('flags tasks that individually exceed the threshold', () => {
      const { rows } = computeBudget([
        { name: 'Big task', items: 6, costClass: 'exploratory' }, // 6 * 11.5 = 69 → mustSplit
        { name: 'Small task', items: 2, costClass: 'bounded' }, // 2 * 2.5 = 5 → fine
      ])
      expect(rows[0].mustSplit).toBe(true)
      expect(rows[1].mustSplit).toBe(false)
    })
  })

  describe('renderBudgetTable', () => {
    it('includes header and separator rows', () => {
      const rows = [classifyTask({ name: 'T1', items: 2, costClass: 'bounded' })]
      const output = renderBudgetTable(rows)
      expect(output).toContain('| Task | Items | Class | Est. ops | Split? |')
      expect(output).toContain('|------|-------|-------|----------|--------|')
    })

    it('shows — for tasks that do not need splitting', () => {
      const rows = [classifyTask({ name: 'Small task', items: 1, costClass: 'trivial' })]
      const output = renderBudgetTable(rows)
      expect(output).toContain('| — |')
    })

    it('shows YES — split required for tasks over the threshold', () => {
      const rows = [classifyTask({ name: 'Big task', items: 6, costClass: 'exploratory' })]
      const output = renderBudgetTable(rows)
      expect(output).toContain('YES — split required')
    })

    it('includes total ops footer', () => {
      const rows = [
        classifyTask({ name: 'T1', items: 2, costClass: 'bounded' }),
        classifyTask({ name: 'T2', items: 1, costClass: 'trivial' }),
      ]
      const output = renderBudgetTable(rows)
      const total = rows.reduce((s, r) => s + r.estimatedOps, 0)
      expect(output).toContain(`**Total estimated ops: ${total}**`)
    })

    it('renders all tasks as table rows', () => {
      const inputs = [
        { name: 'Alpha', items: 3, costClass: 'bounded' as const },
        { name: 'Beta', items: 2, costClass: 'judgmental' as const },
      ]
      const { rows } = computeBudget(inputs)
      const output = renderBudgetTable(rows)
      expect(output).toContain('Alpha')
      expect(output).toContain('Beta')
    })

    it('SPLIT_THRESHOLD constant is 50', () => {
      expect(SPLIT_THRESHOLD).toBe(50)
    })
  })
})
