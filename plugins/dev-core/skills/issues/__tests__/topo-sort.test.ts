import { describe, expect, it } from 'vitest'
import { topoSort } from '../lib/topo-sort'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const noEdges = (_id: number): number[] => []

// ─── A) input-order ───────────────────────────────────────────────────────────

describe('topoSort — input-order', () => {
  it('linear chain: ids=[3,1,2], 2←{3,1} → emits [3,1,2]', () => {
    // Arrange
    // 3 and 1 must be emitted before 2; 3 and 1 have no upstream
    const ids = [3, 1, 2]
    const getUpstream = (id: number): number[] => (id === 2 ? [3, 1] : [])
    // Act
    const result = topoSort(ids, getUpstream, 'input-order')
    // Assert — 3 and 1 are both ready first, input order [3,1] is preserved, then 2
    expect(result).toEqual([3, 1, 2])
  })

  it('independent nodes: ids=[5,3], no edges → preserves input order [5,3]', () => {
    // Arrange
    const ids = [5, 3]
    // Act
    const result = topoSort(ids, noEdges, 'input-order')
    // Assert — no sort applied; input order preserved (NOT [3,5])
    expect(result).toEqual([5, 3])
  })

  it('cycle: ids=[2,1], mutual 1←2 and 2←1 → dumps in ids order [2,1]', () => {
    // Arrange
    const ids = [2, 1]
    const getUpstream = (id: number): number[] => (id === 1 ? [2] : [1])
    // Act
    const result = topoSort(ids, getUpstream, 'input-order')
    // Assert — ready is always empty; cycle dump uses ids order, not sorted
    expect(result).toEqual([2, 1])
  })

  it('single node with no edges → returns that node', () => {
    // Arrange / Act / Assert
    expect(topoSort([7], noEdges, 'input-order')).toEqual([7])
  })

  it('empty ids → returns []', () => {
    // Arrange / Act / Assert
    expect(topoSort([], noEdges, 'input-order')).toEqual([])
  })
})

// ─── B) string-asc (LEXICOGRAPHIC — critical regression lock) ─────────────────

describe('topoSort — string-asc (legacy bare .sort() parity)', () => {
  it('multi-digit tie: ids=[2,10,1], no edges → [1,10,2] (lexicographic, NOT numeric [1,2,10])', () => {
    // Arrange
    const ids = [2, 10, 1]
    // Act
    const result = topoSort(ids, noEdges, 'string-asc')
    // Assert
    // DELIBERATE BEHAVIOR LOCK: this asserts legacy bare-.sort() parity (lexicographic string
    // comparison: '1' < '10' < '2').  Changing topoSort to numeric order MUST update this test.
    // This is an intentional latent bug preserved by the D17 refactor — see #193 follow-up.
    expect(result).toEqual([1, 10, 2])
    // Negative guard: numeric order would be [1,2,10] — must NOT match
    expect(result).not.toEqual([1, 2, 10])
  })

  it('independent nodes: ids=[5,3], no edges → [3,5] (string-asc sort applied)', () => {
    // Arrange / Act / Assert
    // '3' < '5' lexicographically, same as numeric here — confirms sort is applied
    expect(topoSort([5, 3], noEdges, 'string-asc')).toEqual([3, 5])
  })

  it('linear chain mixing multi-digit: ids=[10,2,1], 2←{10}, 1←{2} → [10,2,1]', () => {
    // Arrange
    // 10 has no upstream → emitted first (only ready node, no tie)
    // 2 becomes ready → only ready node, emitted as [2]
    // 1 becomes ready → emitted as [1]
    const ids = [10, 2, 1]
    const getUpstream = (id: number): number[] => {
      if (id === 2) return [10]
      if (id === 1) return [2]
      return []
    }
    // Act
    const result = topoSort(ids, getUpstream, 'string-asc')
    // Assert — each round has exactly one ready node, so tie-break doesn't affect order
    expect(result).toEqual([10, 2, 1])
  })

  it('cycle dump is lexicographic: ids=[10,2], mutual cycle → dump [10,2] ("10"<"2")', () => {
    // Arrange
    const ids = [10, 2]
    const getUpstream = (id: number): number[] => (id === 10 ? [2] : [10])
    // Act
    const result = topoSort(ids, getUpstream, 'string-asc')
    // Assert — cycle dump uses .sort(): '10' < '2' lexicographically → [10,2]
    expect(result).toEqual([10, 2])
  })

  it('single node with no edges → returns that node', () => {
    // Arrange / Act / Assert
    expect(topoSort([42], noEdges, 'string-asc')).toEqual([42])
  })
})
