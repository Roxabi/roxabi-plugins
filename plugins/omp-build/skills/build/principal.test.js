import { describe, expect, it } from 'vitest'
import { pickPrincipal, startPointFor } from './workflow.js'

describe('pickPrincipal', () => {
  it('prefers staging over main and origin/HEAD', () => {
    expect(pickPrincipal(new Set(['main', 'staging', 'master']))).toBe('staging')
  })

  it('uses main when staging is absent', () => {
    expect(pickPrincipal(new Set(['main', 'master']))).toBe('main')
  })

  it('falls back to master', () => {
    expect(pickPrincipal(new Set(['master']))).toBe('master')
  })

  it('returns null when no principal exists', () => {
    expect(pickPrincipal(new Set())).toBeNull()
  })
})

describe('startPointFor', () => {
  it('uses origin/staging when the remote ref exists', () => {
    expect(startPointFor('staging', true)).toBe('origin/staging')
  })

  it('uses the local name when origin is missing', () => {
    expect(startPointFor('main', false)).toBe('main')
  })
})
