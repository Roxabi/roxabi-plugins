import { describe, expect, it } from 'vitest'
import { progressBar } from '../lib/digest-helpers'

// Locks the dual-contract of progressBar introduced in slice-2:
//   - default (no opts) == legacy progressBar behaviour (emptyBar=true, suffix=false)
//   - { suffix: true, emptyBar: false } == legacy show.ts `bar` behaviour

describe('progressBar — default opts (legacy progressBar contract)', () => {
  it('total=0 returns filled empty-bar string (no suffix)', () => {
    // Arrange / Act / Assert
    expect(progressBar(0, 0)).toBe('░░░░░')
  })

  it('partial case returns correct bar without suffix', () => {
    // Arrange
    const closed = 2
    const total = 4
    // Act
    const result = progressBar(closed, total)
    // Assert — filled = round(2/4 * 5) = 3
    expect(result).toBe('███░░')
  })

  it('no opts is identical to explicit default opts', () => {
    // Arrange / Act / Assert
    expect(progressBar(2, 4)).toBe(progressBar(2, 4, {}))
    expect(progressBar(0, 0)).toBe(progressBar(0, 0, {}))
  })
})

describe('progressBar — { suffix: true, emptyBar: false } (legacy show.ts bar contract)', () => {
  it('total=0 returns empty string (not the empty-bar glyphs)', () => {
    // Arrange / Act / Assert
    expect(progressBar(0, 0, { suffix: true, emptyBar: false })).toBe('')
  })

  it('partial case returns bar followed by space + closed/total suffix', () => {
    // Arrange
    const closed = 2
    const total = 4
    // Act
    const result = progressBar(closed, total, { suffix: true, emptyBar: false })
    // Assert — bar = '███░░', suffix = ' 2/4'
    expect(result).toBe('███░░ 2/4')
  })

  it('full case returns all-filled bar with suffix', () => {
    // Arrange / Act / Assert
    expect(progressBar(5, 5, { suffix: true, emptyBar: false })).toBe('█████ 5/5')
  })
})

describe('progressBar — suffix=false, emptyBar=false (explicit false combination)', () => {
  it('total=0 returns empty string', () => {
    expect(progressBar(0, 0, { suffix: false, emptyBar: false })).toBe('')
  })

  it('partial case returns bar only without suffix', () => {
    // filled = round(1/5 * 5) = 1
    expect(progressBar(1, 5, { suffix: false, emptyBar: false })).toBe('█░░░░')
  })
})
