import { describe, expect, it } from 'vitest'
import { isPrincipal, resolveEntry } from './entry.js'

const PRINCIPAL = '/home/dev/roxabi-plugins'
const OMEGA = '/home/dev/.omp/worktrees/roxabi-plugins/feat-493-entry'

describe('resolveEntry — on the Principal', () => {
  it('hops, carrying the exact relocation command — the ω directory, not the branch', () => {
    expect(
      resolveEntry({
        cwd: PRINCIPAL,
        principalPath: PRINCIPAL,
        branch: 'feat/493-feature-front-half',
        ticket: null,
        worktreePath: OMEGA,
      }),
    ).toEqual({
      action: 'hop',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: null,
      command: `omp --cwd ${OMEGA}`,
    })
  })

  it('hops with a ticket too — the Principal is never implemented on', () => {
    const entry = resolveEntry({
      cwd: PRINCIPAL,
      principalPath: PRINCIPAL,
      branch: 'feat/493-feature-front-half',
      ticket: '#493',
      worktreePath: OMEGA,
    })
    expect(entry.action).toBe('hop')
    expect(entry.ticket).toBe(493)
  })

  it('reads through a trailing slash, and echoes neither it nor an untrimmed branch', () => {
    expect(
      resolveEntry({
        cwd: `${PRINCIPAL}/`,
        principalPath: PRINCIPAL,
        branch: '  feat/493-x  ',
        worktreePath: `${OMEGA}/`,
      }),
    ).toEqual({
      action: 'hop',
      reason: 'principal',
      cwd: PRINCIPAL,
      branch: 'feat/493-x',
      ticket: null,
      command: `omp --cwd ${OMEGA}`,
    })
  })

  it('refuses to name a relocation command it does not have', () => {
    expect(() => resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: null })).toThrow(/branch is required/)
  })

  it('refuses to hop without the ω directory the command has to name', () => {
    expect(() => resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'feat/493-x' })).toThrow(
      /worktreePath is required/,
    )
  })

  it('refuses a base branch as the hop target', () => {
    expect(() =>
      resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'staging', worktreePath: OMEGA }),
    ).toThrow(/base branch/)
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
      expect(() => resolveEntry({ cwd, principalPath: PRINCIPAL, branch: 'feat/493-x', worktreePath: OMEGA })).toThrow(
        /cwd must be an absolute, normalised POSIX path/,
      )
    }
    // Repeated *trailing* slashes are the one tolerated denormalisation, so this
    // one must land on the Principal rather than throw — and above all not frame.
    expect(
      resolveEntry({ cwd: `${PRINCIPAL}//`, principalPath: PRINCIPAL, branch: 'feat/493-x', worktreePath: OMEGA })
        .action,
    ).toBe('hop')
    expect(() =>
      resolveEntry({ cwd: PRINCIPAL, principalPath: `${PRINCIPAL}/.`, branch: 'feat/493-x', worktreePath: OMEGA }),
    ).toThrow(/principalPath must be an absolute, normalised POSIX path/)
    expect(() =>
      resolveEntry({ cwd: PRINCIPAL, principalPath: PRINCIPAL, branch: 'feat/493-x', worktreePath: '~/omega' }),
    ).toThrow(/worktreePath must be an absolute, normalised POSIX path/)
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
