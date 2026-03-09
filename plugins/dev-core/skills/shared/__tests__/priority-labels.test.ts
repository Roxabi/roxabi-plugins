import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../adapters/github-adapter', () => ({
  updateLabels: vi.fn(),
}))

const { updateLabels } = await import('../adapters/github-adapter')
const mockUpdateLabels = updateLabels as ReturnType<typeof vi.fn>

const { PRIORITY_LABEL_MAP, PRIORITY_LABELS_SET, syncPriorityLabel } = await import('../adapters/config-helpers')

describe('PRIORITY_LABEL_MAP', () => {
  it('maps all 4 canonical priorities to label names', () => {
    expect(Object.keys(PRIORITY_LABEL_MAP)).toHaveLength(4)
    expect(PRIORITY_LABEL_MAP['P0 - Urgent']).toBe('P0-critical')
    expect(PRIORITY_LABEL_MAP['P1 - High']).toBe('P1-high')
    expect(PRIORITY_LABEL_MAP['P2 - Medium']).toBe('P2-medium')
    expect(PRIORITY_LABEL_MAP['P3 - Low']).toBe('P3-low')
  })
})

describe('PRIORITY_LABELS_SET', () => {
  it('contains all 4 label names derived from the map', () => {
    expect(PRIORITY_LABELS_SET.size).toBe(4)
    expect(PRIORITY_LABELS_SET.has('P0-critical')).toBe(true)
    expect(PRIORITY_LABELS_SET.has('P1-high')).toBe(true)
    expect(PRIORITY_LABELS_SET.has('P2-medium')).toBe(true)
    expect(PRIORITY_LABELS_SET.has('P3-low')).toBe(true)
  })
})

describe('syncPriorityLabel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('calls updateLabels with correct add and remove for P1 - High', async () => {
    mockUpdateLabels.mockResolvedValue(undefined)
    await syncPriorityLabel(42, 'P1 - High')
    expect(mockUpdateLabels).toHaveBeenCalledWith(
      42,
      ['P1-high'],
      expect.arrayContaining(['P0-critical', 'P2-medium', 'P3-low']),
    )
    expect(mockUpdateLabels).toHaveBeenCalledWith(42, ['P1-high'], expect.not.arrayContaining(['P1-high']))
  })

  it('does not throw when updateLabels fails (non-fatal)', async () => {
    mockUpdateLabels.mockRejectedValue(new Error('label error'))
    await expect(syncPriorityLabel(42, 'P0 - Urgent')).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Warning'))
  })

  it('is a no-op for invalid canonical priority', async () => {
    await syncPriorityLabel(42, 'Invalid')
    expect(mockUpdateLabels).not.toHaveBeenCalled()
  })
})
