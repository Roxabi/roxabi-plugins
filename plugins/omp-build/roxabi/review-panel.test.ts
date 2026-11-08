import { describe, expect, it } from 'vitest'
import { allocateReviewPanel, type ReviewPanelInput } from './review-panel.ts'

const empty: ReviewPanelInput = {
  subject: { kind: 'epic-range', range: `${'a'.repeat(40)}..${'a'.repeat(40)}` },
  chunks: [],
  roster: {
    delta: [],
    tier: 'S',
    chunks: 0,
    axialAdr: false,
    stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
    config: { maxAgents: 5, axialOverride: 'default', overrides: { 'R-devops': 'always' }, warnings: [] },
  },
  config: { canonicalClasses: [], chunker: 'chunker.py', digest: 'digest.py' },
  commonContext: 'review',
}

describe('review panel allocation', () => {
  it('allocates the global independent floor and forced roles to context-wide Parent slots', () => {
    const panel = allocateReviewPanel(empty)
    expect(panel.tasks.map(({ role, assignedChunk }) => ({ role, assignedChunk }))).toEqual([
      { role: 'R-adversarial', assignedChunk: null },
      { role: 'R-devops', assignedChunk: null },
    ])
    expect(panel.tasks.every((task) => task.task.includes('no changed-file diff'))).toBe(true)
  })

  it('refuses an ordinary PR with no chunks and inconsistent empty Parent material', () => {
    expect(() => allocateReviewPanel({ ...empty, subject: { kind: 'pull-request' } })).toThrow(
      'review requires chunker output',
    )
    expect(() => allocateReviewPanel({ ...empty, roster: { ...empty.roster, delta: ['changed.ts'] } })).toThrow(
      'changed-file delta',
    )
  })
})
