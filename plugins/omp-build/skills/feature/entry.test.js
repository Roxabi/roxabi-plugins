import { describe, expect, it } from 'vitest'
import { resolveEntry } from './entry.js'

const PRINCIPAL = '/home/dev/roxabi-plugins'
const OMEGA = '/home/dev/.omp/worktrees/roxabi-plugins/feat-493-entry'

describe('resolveEntry — on the Principal', () => {
  it('hops, carrying the exact relocation command', () => {
    expect(
      resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'feat/493-feature-front-half', ticket: null }),
    ).toEqual({
      action: 'hop',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: null,
      command: '/wt feat/493-feature-front-half',
    })
  })

  it('hops with a ticket too — the Principal is never implemented on', () => {
    const entry = resolveEntry({
      cwd: PRINCIPAL,
      principalPath: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: '#493',
    })
    expect(entry.action).toBe('hop')
    expect(entry.ticket).toBe(493)
  })

  it('reads through a trailing slash', () => {
    expect(resolveEntry({ cwd: `${PRINCIPAL}/`, principalPath: PRINCIPAL, branch: 'feat/493-x' }).action).toBe('hop')
  })

  it('refuses to name a relocation command it does not have', () => {
    expect(() => resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: null })).toThrow(/branch is required/)
  })

  it('refuses a base branch as the hop target', () => {
    expect(() => resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'staging' })).toThrow(/base branch/)
  })
})

describe('resolveEntry — inside a worktree', () => {
  it('frames when there is no ticket', () => {
    expect(resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/rate-limiting' })).toEqual({
      action: 'frame',
      cwd: OMEGA,
      branch: 'feat/rate-limiting',
      ticket: null,
    })
  })

  it('does not mistake a worktree nested under the Principal for the Principal', () => {
    const nested = `${PRINCIPAL}/.claude/worktrees/493-feature-front-half`
    expect(resolveEntry({ cwd: nested, principalPath: PRINCIPAL, branch: 'feat/493-x' }).action).toBe('frame')
  })

  it('builds when the branch claims the ticket', () => {
    expect(
      resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/493-feature-front-half', ticket: 493 }),
    ).toEqual({
      action: 'build',
      cwd: OMEGA,
      branch: 'feat/493-feature-front-half',
      ticket: 493,
    })
  })

  it('accepts the operator forms of a ticket', () => {
    for (const ticket of [493, '493', ' #493 ']) {
      expect(resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'fix/493-x', ticket }).action).toBe('build')
    }
  })
})

describe('resolveEntry — branch mismatch', () => {
  it('refuses to implement #N on another ticket’s branch', () => {
    expect(resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/494-build-half', ticket: 493 })).toEqual({
      action: 'refuse',
      reason: 'branch-mismatch',
      cwd: OMEGA,
      branch: 'feat/494-build-half',
      ticket: 493,
      branchTicket: 494,
    })
  })

  it('does not accept a longer number that merely starts with the ticket', () => {
    const entry = resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/4930-decoy', ticket: 493 })
    expect(entry.action).toBe('refuse')
    expect(entry.branchTicket).toBe(4930)
  })

  it('requires the ticket to end the segment, not just open it', () => {
    const entry = resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/493x-typo', ticket: 493 })
    expect(entry.action).toBe('refuse')
    expect(entry.branchTicket).toBeNull()
  })

  it('refuses a branch that claims no ticket at all', () => {
    const entry = resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/rate-limiting', ticket: 493 })
    expect(entry.action).toBe('refuse')
    expect(entry.branchTicket).toBeNull()
  })

  it('refuses a detached HEAD', () => {
    const entry = resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: null, ticket: 493 })
    expect(entry.action).toBe('refuse')
    expect(entry.branchTicket).toBeNull()
  })
})

describe('resolveEntry — rejected inputs', () => {
  it('requires cwd and principalPath', () => {
    expect(() => resolveEntry({ principalPath: PRINCIPAL, branch: 'feat/493-x' })).toThrow(/cwd is required/)
    expect(() => resolveEntry({ cwd: OMEGA, principalPath: '  ', branch: 'feat/493-x' })).toThrow(
      /principalPath is required/,
    )
  })

  it('rejects a ticket that is not an issue number', () => {
    for (const ticket of ['abc', '#', 0, -3, 4.5]) {
      expect(() => resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'feat/493-x', ticket })).toThrow(
        /positive issue number/,
      )
    }
  })
})
