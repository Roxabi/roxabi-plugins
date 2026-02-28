import { describe, expect, it } from 'vitest'
import {
  BLOCK_ORDER,
  FIELD_MAP,
  PRIORITY_ALIASES,
  PRIORITY_OPTIONS,
  PRIORITY_ORDER,
  resolvePriority,
  resolveSize,
  resolveStatus,
  SIZE_OPTIONS,
  STATUS_ALIASES,
  STATUS_OPTIONS,
} from '../config'

describe('shared/config', () => {
  describe('option maps', () => {
    it('STATUS_OPTIONS has all 6 statuses', () => {
      expect(Object.keys(STATUS_OPTIONS)).toEqual([
        'Backlog',
        'Analysis',
        'Specs',
        'In Progress',
        'Review',
        'Done',
      ])
    })

    it('SIZE_OPTIONS has all 5 sizes', () => {
      expect(Object.keys(SIZE_OPTIONS)).toEqual(['XS', 'S', 'M', 'L', 'XL'])
    })

    it('PRIORITY_OPTIONS has all 4 priorities', () => {
      expect(Object.keys(PRIORITY_OPTIONS)).toEqual([
        'P0 - Urgent',
        'P1 - High',
        'P2 - Medium',
        'P3 - Low',
      ])
    })

    it('all option IDs are unique within each map', () => {
      for (const map of [STATUS_OPTIONS, SIZE_OPTIONS, PRIORITY_OPTIONS]) {
        const values = Object.values(map)
        expect(new Set(values).size).toBe(values.length)
      }
    })
  })

  describe('FIELD_MAP', () => {
    it('contains status, size, and priority', () => {
      expect(Object.keys(FIELD_MAP)).toEqual(['status', 'size', 'priority'])
    })

    it('each entry has a fieldId and options', () => {
      for (const entry of Object.values(FIELD_MAP)) {
        expect(entry.fieldId).toBeTruthy()
        expect(Object.keys(entry.options).length).toBeGreaterThan(0)
      }
    })
  })

  describe('aliases', () => {
    it('STATUS_ALIASES covers all uppercase variants', () => {
      expect(STATUS_ALIASES.BACKLOG).toBe('Backlog')
      expect(STATUS_ALIASES['IN PROGRESS']).toBe('In Progress')
      expect(STATUS_ALIASES.IN_PROGRESS).toBe('In Progress')
      expect(STATUS_ALIASES.INPROGRESS).toBe('In Progress')
    })

    it('PRIORITY_ALIASES covers short and full forms', () => {
      expect(PRIORITY_ALIASES.URGENT).toBe('P0 - Urgent')
      expect(PRIORITY_ALIASES.HIGH).toBe('P1 - High')
      expect(PRIORITY_ALIASES.P0).toBe('P0 - Urgent')
      expect(PRIORITY_ALIASES.P1).toBe('P1 - High')
    })
  })

  describe('resolveStatus', () => {
    it('resolves canonical values', () => {
      expect(resolveStatus('Backlog')).toBe('Backlog')
      expect(resolveStatus('In Progress')).toBe('In Progress')
    })

    it('resolves uppercase aliases', () => {
      expect(resolveStatus('BACKLOG')).toBe('Backlog')
      expect(resolveStatus('IN PROGRESS')).toBe('In Progress')
      expect(resolveStatus('in_progress')).toBe('In Progress')
    })

    it('returns undefined for invalid input', () => {
      expect(resolveStatus('invalid')).toBeUndefined()
    })
  })

  describe('resolvePriority', () => {
    it('resolves canonical values', () => {
      expect(resolvePriority('P0 - Urgent')).toBe('P0 - Urgent')
    })

    it('resolves short aliases', () => {
      expect(resolvePriority('Urgent')).toBe('P0 - Urgent')
      expect(resolvePriority('High')).toBe('P1 - High')
      expect(resolvePriority('medium')).toBe('P2 - Medium')
      expect(resolvePriority('LOW')).toBe('P3 - Low')
    })

    it('resolves P-number aliases', () => {
      expect(resolvePriority('P0')).toBe('P0 - Urgent')
      expect(resolvePriority('p3')).toBe('P3 - Low')
    })

    it('returns undefined for invalid input', () => {
      expect(resolvePriority('none')).toBeUndefined()
    })
  })

  describe('resolveSize', () => {
    it('resolves all valid sizes (case-insensitive)', () => {
      expect(resolveSize('xs')).toBe('XS')
      expect(resolveSize('S')).toBe('S')
      expect(resolveSize('m')).toBe('M')
      expect(resolveSize('L')).toBe('L')
      expect(resolveSize('xl')).toBe('XL')
    })

    it('returns undefined for invalid input', () => {
      expect(resolveSize('XXL')).toBeUndefined()
    })
  })

  describe('sort orders', () => {
    it('PRIORITY_ORDER ranks P0 highest', () => {
      expect(PRIORITY_ORDER['P0 - Urgent']).toBeLessThan(PRIORITY_ORDER['P3 - Low'])
    })

    it('BLOCK_ORDER ranks blocking first', () => {
      expect(BLOCK_ORDER.blocking).toBeLessThan(BLOCK_ORDER.ready)
      expect(BLOCK_ORDER.ready).toBeLessThan(BLOCK_ORDER.blocked)
    })
  })
})
