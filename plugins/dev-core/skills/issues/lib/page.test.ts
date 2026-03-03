/**
 * Tests for per-project column helpers in page.ts.
 * RED phase: fail until Task 3.2 adds the helpers.
 */

import { describe, expect, test } from 'vitest'
import type { WorkspaceProject } from '../../shared/workspace'

// @ts-expect-error — columnLabel / showCI / etc. may not exist yet (RED phase)
const { columnLabel, showCI, showDevLinks, showSubIssues, defaultSort } = await import('./page')

const base: Omit<WorkspaceProject, 'type'> = { repo: 'test/test', projectId: 'PVT_1', label: 'test' }
const tech: WorkspaceProject = { ...base, type: 'technical' }
const co: WorkspaceProject = { ...base, type: 'company' }

describe('columnLabel', () => {
  test('col2 for technical = Size', () => {
    expect(columnLabel(tech, 'col2')).toEqual({ label: 'Size', icon: '📐' })
  })
  test('col3 for technical = Pri', () => {
    expect(columnLabel(tech, 'col3')).toEqual({ label: 'Pri', icon: '🔥' })
  })
  test('col2 for company = Quarter', () => {
    expect(columnLabel(co, 'col2')).toEqual({ label: 'Quarter', icon: '📅' })
  })
  test('col3 for company = Pillar', () => {
    expect(columnLabel(co, 'col3')).toEqual({ label: 'Pillar', icon: '🏛' })
  })
  test('defaults to technical when type undefined', () => {
    const noType: WorkspaceProject = { ...base }
    expect(columnLabel(noType, 'col2')).toEqual({ label: 'Size', icon: '📐' })
  })
})

describe('showCI', () => {
  test('technical project shows CI', () => {
    expect(showCI(tech)).toBe(true)
  })
  test('company project hides CI', () => {
    expect(showCI(co)).toBe(false)
  })
  test('defaults to showing CI when type undefined', () => {
    expect(showCI({ ...base })).toBe(true)
  })
})

describe('showDevLinks', () => {
  test('technical shows dev links', () => {
    expect(showDevLinks(tech)).toBe(true)
  })
  test('company hides dev links', () => {
    expect(showDevLinks(co)).toBe(false)
  })
})

describe('showSubIssues', () => {
  test('technical shows sub-issues graph', () => {
    expect(showSubIssues(tech)).toBe(true)
  })
  test('company hides sub-issues graph', () => {
    expect(showSubIssues(co)).toBe(false)
  })
})

describe('defaultSort', () => {
  test('technical sorts by priority-desc', () => {
    expect(defaultSort(tech)).toBe('priority-desc')
  })
  test('company sorts by col2-asc (quarter ascending)', () => {
    expect(defaultSort(co)).toBe('col2-asc')
  })
  test('defaults to priority-desc when type undefined', () => {
    expect(defaultSort({ ...base })).toBe('priority-desc')
  })
})
