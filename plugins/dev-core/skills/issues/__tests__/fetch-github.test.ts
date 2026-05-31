import { describe, expect, it } from 'vitest'
import { mapRawCheck } from '../lib/fetch-github'

// mapRawCheck is a pure function — no network, no mocking needed.

describe('mapRawCheck', () => {
  it('maps a CheckRun node (has status + conclusion)', () => {
    const result = mapRawCheck({ status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://example.com' })
    expect(result.status).toBe('COMPLETED')
    expect(result.conclusion).toBe('SUCCESS')
    expect(result.detailsUrl).toBe('https://example.com')
  })

  it('maps a StatusContext node (has state, no status/conclusion)', () => {
    const result = mapRawCheck({ context: 'ci/build', state: 'SUCCESS', targetUrl: 'https://ci.example.com' })
    expect(result.name).toBe('ci/build')
    expect(result.status).toBe('SUCCESS')
    expect(result.conclusion).toBe('')
    expect(result.detailsUrl).toBe('https://ci.example.com')
  })

  it('falls back name to "unknown" when neither name nor context is present', () => {
    const result = mapRawCheck({ status: 'QUEUED' })
    expect(result.name).toBe('unknown')
  })

  it('maps an unknown status to sentinel empty string', () => {
    const result = mapRawCheck({ status: 'TOTALLY_MADE_UP' })
    expect(result.status).toBe('')
  })

  it('maps an unknown conclusion to sentinel empty string', () => {
    const result = mapRawCheck({ status: 'COMPLETED', conclusion: 'NOT_REAL' })
    expect(result.conclusion).toBe('')
  })

  it('maps a known StatusState value as status (e.g. ERROR)', () => {
    const result = mapRawCheck({ state: 'ERROR' })
    expect(result.status).toBe('ERROR')
  })
})
