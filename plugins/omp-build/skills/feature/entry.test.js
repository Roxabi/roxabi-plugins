import { describe, expect, it } from 'vitest'
import { isPrincipal, resolveEntry } from './entry.js'

const PRINCIPAL = '/home/dev/roxabi-plugins'
const OMEGA = '/home/dev/.omp/worktrees/roxabi-plugins/feat-493-entry'

describe('resolveEntry — on the Principal', () => {
  it('refuses, and does not name a relocation command', () => {
    expect(
      resolveEntry({
        cwd: PRINCIPAL,
        principalPath: PRINCIPAL,
        branch: 'feat/493-feature-front-half',
        ticket: null,
      }),
    ).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: null,
      branchTicket: 493,
    })
  })

  it('refuses with a ticket too — the Principal is never implemented on', () => {
    expect(
      resolveEntry({
        cwd: PRINCIPAL,
        principalPath: PRINCIPAL,
        branch: 'feat/493-feature-front-half',
        ticket: '#493',
      }),
    ).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: 493,
      branchTicket: 493,
    })
  })

  it('refuses a trailing-slash Principal rather than framing', () => {
    expect(
      resolveEntry({
        cwd: `${PRINCIPAL}/`,
        principalPath: PRINCIPAL,
        branch: '  feat/493-x  ',
      }),
    ).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-x',
      ticket: null,
      branchTicket: 493,
    })
  })

  it('refuses with no branch', () => {
    expect(resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: null })).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: null,
      ticket: null,
      branchTicket: null,
    })
  })

  it('refuses a base branch on the Principal instead of throwing', () => {
    expect(resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'staging' })).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'staging',
      ticket: null,
      branchTicket: null,
    })
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
    expect(resolveEntry({ cwd: nested, principalPath: PRINCIPAL, branch: 'feat/493-x' })).toEqual({
      action: 'frame',
      cwd: nested,
      branch: 'feat/493-x',
      ticket: null,
    })
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
      expect(resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'fix/493-x', ticket })).toEqual({
        action: 'build',
        cwd: OMEGA,
        branch: 'fix/493-x',
        ticket: 493,
      })
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

  it('reads the ticket at the head of the branch, not anywhere inside it', () => {
    // `git symbolic-ref HEAD` prints the fully-qualified ref. Unanchored, the
    // convention matches at `feat/493-` and the ref builds — on a branch name the
    // caller never proved it is on.
    expect(
      resolveEntry({ cwd: OMEGA, principalPath: PRINCIPAL, branch: 'refs/heads/feat/493-x', ticket: 493 }),
    ).toEqual({
      action: 'refuse',
      reason: 'branch-mismatch',
      cwd: OMEGA,
      branch: 'refs/heads/feat/493-x',
      ticket: 493,
      branchTicket: null,
    })
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

describe('resolveEntry — epic route', () => {
  const EPIC = { cwd: OMEGA, principalPath: PRINCIPAL, ticket: 575, children: [577, 578] }

  it('routes an epic with sub-issues from a detached epic worktree', () => {
    expect(resolveEntry({ ...EPIC, branch: null })).toEqual({
      action: 'epic',
      cwd: OMEGA,
      branch: null,
      ticket: 575,
      children: [577, 578],
    })
  })

  it('routes it from a branch that claims one of its children', () => {
    expect(resolveEntry({ ...EPIC, branch: 'fix/578-landing' }).action).toBe('epic')
  })

  it('refuses a branch that claims a ticket outside the epic', () => {
    expect(resolveEntry({ ...EPIC, branch: 'feat/5770-decoy' })).toEqual({
      action: 'refuse',
      reason: 'branch-mismatch',
      cwd: OMEGA,
      branch: 'feat/5770-decoy',
      ticket: 575,
      branchTicket: 5770,
    })
  })

  it('never routes an epic on the Principal', () => {
    expect(resolveEntry({ ...EPIC, cwd: PRINCIPAL, branch: null })).toMatchObject({
      action: 'refuse',
      reason: 'principal',
    })
  })

  it('keeps the assisted routes when the ticket has no sub-issues', () => {
    for (const children of [undefined, null, []]) {
      expect(resolveEntry({ ...EPIC, children, branch: null }).action).toBe('refuse')
      expect(resolveEntry({ ...EPIC, children, branch: 'feat/577-x' }).action).toBe('refuse')
    }
    expect(resolveEntry({ ...EPIC, branch: 'feat/575-epic' }).action).toBe('build')
  })

  it('rejects children that are not issue numbers', () => {
    for (const children of ['577', [577, '578'], [0], [4.5]]) {
      expect(() => resolveEntry({ ...EPIC, children, branch: null })).toThrow(/children must be a list/)
    }
  })
})

describe('resolveEntry — rejected inputs', () => {
  it('requires cwd and principalPath', () => {
    expect(() => resolveEntry({ principalPath: PRINCIPAL, branch: 'feat/493-x' })).toThrow(/cwd is required/)
    expect(() => resolveEntry({ cwd: OMEGA, principalPath: '  ', branch: 'feat/493-x' })).toThrow(
      /principalPath is required/,
    )
  })

  it('refuses every spelling under which the Principal would fail to equal itself', () => {
    // Each of these used to fall through to `frame` — i.e. frame, or implement,
    // on the Principal, with nothing downstream to catch it: the tool_call
    // interceptor blocks `bun test` and base-branch switches, never a write.
    for (const cwd of [
      'roxabi-plugins', // relative
      `${PRINCIPAL}/.`, // undotted by any resolver, equal to the Principal
      `${PRINCIPAL}/../roxabi-plugins`,
      '/home/dev//roxabi-plugins',
      'C:\\dev\\roxabi-plugins',
      `${PRINCIPAL}\\sub`,
    ]) {
      expect(() => resolveEntry({ cwd, principalPath: PRINCIPAL, branch: 'feat/493-x' })).toThrow(
        /cwd must be an absolute, normalised POSIX path/,
      )
    }
    // Repeated *trailing* slashes are the one tolerated denormalisation, so this
    // one must land on the Principal rather than throw — and above all not frame.
    expect(resolveEntry({ cwd: `${PRINCIPAL}//`, principalPath: PRINCIPAL, branch: 'feat/493-x' })).toEqual({
      action: 'refuse',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-x',
      ticket: null,
      branchTicket: 493,
    })
    expect(() => resolveEntry({ cwd: PRINCIPAL, principalPath: `${PRINCIPAL}/.`, branch: 'feat/493-x' })).toThrow(
      /principalPath must be an absolute, normalised POSIX path/,
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

describe('isPrincipal', () => {
  it('answers the location question with no branch in hand', () => {
    expect(isPrincipal(PRINCIPAL, PRINCIPAL)).toBe(true)
    expect(isPrincipal(`${PRINCIPAL}/`, PRINCIPAL)).toBe(true)
    expect(isPrincipal(OMEGA, PRINCIPAL)).toBe(false)
    expect(isPrincipal(`${PRINCIPAL}/.claude/worktrees/493-x`, PRINCIPAL)).toBe(false)
  })

  it('refuses a path it cannot compare, instead of answering false', () => {
    expect(() => isPrincipal(`${PRINCIPAL}/.`, PRINCIPAL)).toThrow(/cwd must be an absolute, normalised POSIX path/)
  })
})
