import { describe, expect, it } from 'vitest'
import { cleanTitle, shortTitle } from '../lib/components'

describe('cleanTitle', () => {
  it('strips conventional-commit prefix with scope: feat(x): ...', () => {
    // Arrange / Act / Assert
    expect(cleanTitle('feat(x): Add login page')).toBe('Add login page')
  })

  it('strips conventional-commit prefix with scope: fix(y): ...', () => {
    expect(cleanTitle('fix(y): Fix broken route')).toBe('Fix broken route')
  })

  it('does NOT strip conventional-commit prefix without scope (requires parens)', () => {
    // cleanTitle only strips <type>(<scope>): patterns — scopeless are left intact
    expect(cleanTitle('chore: Update deps')).toBe('chore: Update deps')
    expect(cleanTitle('refactor: Extract helper')).toBe('refactor: Extract helper')
  })

  it('strips Feature: prefix (case-insensitive)', () => {
    expect(cleanTitle('Feature: New dashboard')).toBe('New dashboard')
  })

  it('strips LATER: prefix', () => {
    expect(cleanTitle('LATER: Revisit auth flow')).toBe('Revisit auth flow')
  })

  it('strips trailing parenthetical (…)', () => {
    expect(cleanTitle('Refactor parser (WIP)')).toBe('Refactor parser')
  })

  it('strips trailing parenthetical with extra text', () => {
    expect(cleanTitle('Add search (blocked by API)')).toBe('Add search')
  })

  it('leaves a plain title unchanged', () => {
    expect(cleanTitle('Plain issue title')).toBe('Plain issue title')
  })

  it('handles combined: conventional prefix + trailing paren', () => {
    // Both transforms applied in sequence
    expect(cleanTitle('feat(ui): Button redesign (draft)')).toBe('Button redesign')
  })
})

describe('shortTitle', () => {
  it('returns cleaned title unchanged when ≤ max chars (22)', () => {
    // Arrange — 22 chars exactly after cleaning
    const title = 'Short clean title here'
    // Act
    const result = shortTitle(title)
    // Assert — length is 22, no truncation
    expect(result).toBe('Short clean title here')
    expect(result.length).toBe(22)
  })

  it('truncates to slice(0,21) + "..." when cleaned title > 22 chars', () => {
    // Arrange — 23 chars after cleaning
    const title = 'This is a longer title!'
    // Act
    const result = shortTitle(title)
    // Assert — 21 chars + '...'
    expect(result).toBe('This is a longer titl...')
    expect(result.length).toBe(24) // 21 + 3
  })

  it('applies cleanTitle before truncating (strips prefix first)', () => {
    // Arrange — after stripping 'feat(scope): ' the remainder is > 22 chars
    const title = 'feat(ui): This is a very long title that should be truncated'
    // Act
    const result = shortTitle(title)
    // Assert — cleaned = 'This is a very long title that should be truncated' (50 chars)
    // slice(0,21) = 'This is a very long t', + '...'
    expect(result).toBe('This is a very long t...')
  })

  it('respects a custom max parameter', () => {
    // Arrange
    const title = 'Longer than ten chars here'
    // Act — max=10: slice(0,9) + '...'
    const result = shortTitle(title, 10)
    // Assert
    expect(result).toBe('Longer th...')
    expect(result.length).toBe(12) // 9 + 3
  })

  it('returns cleaned short title unchanged with custom max', () => {
    // Arrange
    const title = 'Short'
    // Act
    const result = shortTitle(title, 10)
    // Assert — 5 chars ≤ 10, no truncation
    expect(result).toBe('Short')
  })
})
