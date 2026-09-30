/**
 * `/feature` entry resolution (ADR-020 §3, #493; epic route #620).
 *
 * Pure by construction: no fs, no git, no network, no clock. Every input the
 * decision needs arrives as a parameter, so `/feature` cannot decide *where it is*
 * by probing the machine it happens to run on — and the decision is testable
 * without a repository.
 *
 * The caller supplies the facts:
 *   - `cwd`            the session's working directory, absolute and normalised
 *   - `principalPath`  the first `git worktree list --porcelain` entry
 *   - `branch`         the branch checked out at `cwd`, or nothing
 *   - `ticket`         the tracker issue the operator named, or nothing
 *   - `children`       the ticket's sub-issue numbers, or nothing
 *
 * Path inputs are compared as strings, never resolved: this module may not touch
 * the filesystem, so it cannot undo a symlink, a case-variant spelling, or a
 * relative segment. It therefore refuses anything that is not already an absolute,
 * normalised POSIX path (`pwd -P` / `git rev-parse --show-toplevel`), rather than
 * letting an unequal spelling of the Principal read as "not the Principal" — which
 * would frame, or implement, on the Principal itself.
 */

import { resolveTicketBranch, ticketOfBranch } from './epic'

/** Operator forms accepted for a ticket: `493`, `'493'`, `'#493'`. */
const TICKET_RE = /^#?(\d+)$/

/**
 * @typedef {{ action: 'frame', cwd: string, branch: string | null, ticket: null }} FrameEntry
 * @typedef {{ action: 'build', cwd: string, branch: string, ticket: number }} BuildEntry
 * @typedef {{ action: 'epic', cwd: string, branch: string | null, ticket: number, children: number[] }} EpicEntry
 * @typedef {{ action: 'refuse', reason: 'branch-mismatch' | 'principal', cwd: string, branch: string | null, ticket: number | null, branchTicket: number | null }} RefuseEntry
 * @typedef {FrameEntry | BuildEntry | EpicEntry | RefuseEntry} Entry
 */

/**
 * Absolute, POSIX, and carrying no segment a resolver would have collapsed.
 * @param {string} path
 * @returns {boolean}
 */
function isNormalizedAbsolute(path) {
  if (path === '/') return true
  if (!path.startsWith('/') || path.includes('\\')) return false
  return path
    .slice(1)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * @param {unknown} path
 * @param {string} label
 * @returns {string}
 */
function normalizePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError(`entry: ${label} is required`)
  }
  const trimmed = path.trim()
  // Exactly one denormalisation is tolerated, because shells and completions add
  // it to a path that is otherwise resolved: a trailing slash. `.`, `..`, `//`,
  // `\`, and a relative path are refused — each of them is a spelling under which
  // the Principal would silently fail to equal itself.
  const stripped = trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '')
  if (!isNormalizedAbsolute(stripped)) {
    throw new TypeError(
      `entry: ${label} must be an absolute, normalised POSIX path (pwd -P), got ${JSON.stringify(path)}`,
    )
  }
  return stripped
}

/**
 * @param {unknown} ticket
 * @returns {number | null}
 */
function normalizeTicket(ticket) {
  if (ticket === null || ticket === undefined || ticket === '') return null
  const match = TICKET_RE.exec(String(ticket).trim())
  const issue = match ? Number(match[1]) : Number.NaN
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new TypeError(`resolveEntry: ticket must be a positive issue number or "#N", got ${JSON.stringify(ticket)}`)
  }
  return issue
}

/**
 * @param {unknown} children
 * @returns {number[]}
 */
function normalizeChildren(children) {
  if (children === null || children === undefined) return []
  if (!Array.isArray(children) || !children.every((n) => Number.isInteger(n) && n > 0)) {
    throw new TypeError(`resolveEntry: children must be a list of issue numbers, got ${JSON.stringify(children)}`)
  }
  return children
}

/**
 * Is this invocation sitting on the Principal?
 *
 * Exported on its own because §3-vs-§4 has to be decided *before* there is a
 * branch to speak of: on the Principal the branch `/feature` is about is the one
 * §3 has not created yet, and reading HEAD there yields a base branch that
 * `resolveEntry` refuses by design. So the location question is answered without
 * a branch, and `resolveEntry` is called once, afterwards, with the ω it now has.
 *
 * Exact equality, never a prefix: a worktree may live *inside* the Principal
 * (`.claude/worktrees/<slug>`), and a prefix test would call it the Principal.
 *
 * @param {string} cwd
 * @param {string} principalPath
 * @returns {boolean}
 */
export function isPrincipal(cwd, principalPath) {
  return normalizePath(cwd, 'cwd') === normalizePath(principalPath, 'principalPath')
}

/**
 * Where this `/feature` invocation is, and what it must do next.
 *
 * | Situation | Action |
 * |---|---|
 * | `cwd` is the Principal | `refuse` — reason `principal`; never implement here |
 * | in ω, no ticket | `frame` — mode 1: grill → spec → tickets → frontier |
 * | in ω, ticket, branch claims that ticket | `build` — mode 2 (#494) |
 * | in ω, ticket with sub-issues, HEAD detached or on a branch claiming one of them | `epic` — the Epic goal (#620) |
 * | in ω, ticket, branch claims another one or none | `refuse` — never implement #N on #M's branch |
 *
 * The last row is the one worth stating out loud: implementing #N inside the
 * worktree of #M puts #N's commits on #M's branch and into #M's PR, silently. A
 * branch that does not carry the ticket is therefore never built on — including a
 * detached HEAD (`branch: null`) and a branch that does not follow the convention,
 * because neither *proves* it is the right place. `refuse` reports both numbers
 * and lets the caller phrase the corrective move. The `epic` row is the one
 * exception: an epic worktree is detached between children and on a child's
 * branch during one, and the Epic goal, not this route, decides what runs there.
 *
 * @param {{ cwd: string, principalPath: string, branch?: string | null, ticket?: string | number | null, children?: number[] | null }} input
 * @returns {Entry}
 */
export function resolveEntry({ cwd, principalPath, branch = null, ticket = null, children = null } = {}) {
  const here = normalizePath(cwd, 'cwd')
  const principal = normalizePath(principalPath, 'principalPath')
  const issue = normalizeTicket(ticket)
  const subIssues = normalizeChildren(children)
  const head = typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null

  if (isPrincipal(here, principal)) {
    return {
      action: 'refuse',
      reason: 'principal',
      cwd: here,
      branch: head,
      ticket: issue,
      branchTicket: ticketOfBranch(head),
    }
  }

  if (issue === null) return { action: 'frame', cwd: here, branch: head, ticket: null }

  const branchTicket = ticketOfBranch(head)
  if (branchTicket === issue) return { action: 'build', cwd: here, branch: head, ticket: issue }
  if (subIssues.length && (head === null || 'ticket' in resolveTicketBranch(head, subIssues))) {
    return { action: 'epic', cwd: here, branch: head, ticket: issue, children: subIssues }
  }
  return { action: 'refuse', reason: 'branch-mismatch', cwd: here, branch: head, ticket: issue, branchTicket }
}
