import { describe, expect, it } from 'vitest'
import {
  asCheckConclusionState,
  asCheckStatusState,
  asMergeableState,
  asPullRequestState,
  asWorkflowConclusion,
  asWorkflowStatus,
} from '../lib/gh-enums'

describe('asCheckStatusState', () => {
  it('passes a valid CheckStatusState member through unchanged', () => {
    expect(asCheckStatusState('COMPLETED')).toBe('COMPLETED')
  })

  it('passes a valid StatusState member through unchanged', () => {
    expect(asCheckStatusState('SUCCESS')).toBe('SUCCESS')
  })

  it('maps an unknown string to the sentinel empty string', () => {
    expect(asCheckStatusState('UNKNOWN_BOGUS')).toBe('')
  })

  it('maps an empty string to sentinel empty string', () => {
    expect(asCheckStatusState('')).toBe('')
  })
})

describe('asCheckConclusionState', () => {
  it('passes a valid member through unchanged', () => {
    expect(asCheckConclusionState('FAILURE')).toBe('FAILURE')
  })

  it('maps an unknown string to the sentinel empty string', () => {
    expect(asCheckConclusionState('NOT_A_CONCLUSION')).toBe('')
  })

  it('maps empty string to sentinel empty string', () => {
    expect(asCheckConclusionState('')).toBe('')
  })
})

describe('asMergeableState', () => {
  it('passes a valid member through unchanged', () => {
    expect(asMergeableState('MERGEABLE')).toBe('MERGEABLE')
  })

  it('passes UNKNOWN through (natural sentinel)', () => {
    expect(asMergeableState('UNKNOWN')).toBe('UNKNOWN')
  })

  it('maps an unknown string to the UNKNOWN sentinel', () => {
    expect(asMergeableState('BOGUS')).toBe('UNKNOWN')
  })
})

describe('asPullRequestState', () => {
  it('passes a valid member through unchanged', () => {
    expect(asPullRequestState('OPEN')).toBe('OPEN')
  })

  it('passes MERGED through unchanged', () => {
    expect(asPullRequestState('MERGED')).toBe('MERGED')
  })

  it('maps an unknown string to the sentinel empty string', () => {
    expect(asPullRequestState('DRAFT')).toBe('')
  })
})

describe('asWorkflowStatus', () => {
  it('passes a valid member through unchanged', () => {
    expect(asWorkflowStatus('completed')).toBe('completed')
  })

  it('passes in_progress through unchanged', () => {
    expect(asWorkflowStatus('in_progress')).toBe('in_progress')
  })

  it('maps an unknown string to the sentinel empty string', () => {
    expect(asWorkflowStatus('RUNNING')).toBe('')
  })
})

describe('asWorkflowConclusion', () => {
  it('passes a valid member through unchanged', () => {
    expect(asWorkflowConclusion('success')).toBe('success')
  })

  it('passes cancelled through unchanged', () => {
    expect(asWorkflowConclusion('cancelled')).toBe('cancelled')
  })

  it('maps null to null', () => {
    expect(asWorkflowConclusion(null)).toBeNull()
  })

  it('maps an unknown string to null', () => {
    expect(asWorkflowConclusion('BOGUS_CONCLUSION')).toBeNull()
  })
})
