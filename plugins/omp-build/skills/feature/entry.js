/**
 * `/feature` entry resolution (ADR-020 §3, #493).
 *
 * Pure by construction: no fs, no git, no network, no clock. Every input the
 * decision needs arrives as a parameter, so `/feature` cannot decide *where it is*
 * by probing the machine it happens to run on — and the decision is testable
 * without a repository.
 *
 * The caller supplies the facts:
 *   - `cwd`            the session's working directory
 *   - `principalPath`  the first `git worktree list --porcelain` entry
 *   - `branch`         the feature branch this invocation is about: inside ω it is
 *                      the branch checked out at `cwd`; on the Principal it is the
 *                      branch of the ω `/feature` has just created
 *   - `ticket`         the tracker issue the operator named, or nothing
 */

/** Operator forms accepted for a ticket: `493`, `'493'`, `'#493'`. */
const TICKET_RE = /^#?(\d+)$/

/** Branch convention: `<type>/<issue>-<slug>` — `resolveNames` in `../build/workflow.js`. */
const BRANCH_TICKET_RE = /^[^/]+\/(\d+)(?:-|$)/

/**
 * @typedef {{ action: 'hop', reason: 'principal', cwd: string, branch: string, ticket: number | null, command: string }} HopEntry
 * @typedef {{ action: 'frame', cwd: string, branch: string | null, ticket: null }} FrameEntry
 * @typedef {{ action: 'build', cwd: string, branch: string, ticket: number }} BuildEntry
 * @typedef {{ action: 'refuse', reason: 'branch-mismatch', cwd: string, branch: string | null, ticket: number, branchTicket: number | null }} RefuseEntry
 * @typedef {HopEntry | FrameEntry | BuildEntry | RefuseEntry} Entry
 */

/**
 * @param {unknown} path
 * @param {string} label
 * @returns {string}
 */
function normalizePath(path, label) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new TypeError(`resolveEntry: ${label} is required`)
  }
  const trimmed = path.trim().replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
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
 * The issue a branch name claims, or `null` when it claims none.
 * @param {string | null} branch
 * @returns {number | null}
 */
function ticketOfBranch(branch) {
  if (branch === null) return null
  const match = BRANCH_TICKET_RE.exec(branch)
  return match ? Number(match[1]) : null
}

/**
 * Where this `/feature` invocation is, and what it must do next.
 *
 * | Situation | Action |
 * |---|---|
 * | `cwd` is the Principal | `hop` — carries `command`, the exact relocation line |
 * | in ω, no ticket | `frame` — mode 1: grill → spec → tickets → frontier |
 * | in ω, ticket, branch claims that ticket | `build` — mode 2 (#494) |
 * | in ω, ticket, branch claims another one or none | `refuse` — never implement #N on #M's branch |
 *
 * The last row is the one worth stating out loud: implementing #N inside the
 * worktree of #M puts #N's commits on #M's branch and into #M's PR, silently. A
 * branch that does not carry the ticket is therefore never built on — including a
 * detached HEAD (`branch: null`) and a branch that does not follow the convention,
 * because neither *proves* it is the right place. The corrective move is a hop the
 * caller cannot name here (the target's slug lives in the tracker, not in these
 * inputs), so `refuse` reports both numbers and lets the caller phrase it.
 *
 * @param {{ cwd: string, principalPath: string, branch?: string | null, ticket?: string | number | null }} input
 * @returns {Entry}
 */
export function resolveEntry({ cwd, principalPath, branch = null, ticket = null } = {}) {
  const here = normalizePath(cwd, 'cwd')
  const principal = normalizePath(principalPath, 'principalPath')
  const issue = normalizeTicket(ticket)
  const head = typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null

  // Exact equality, never a prefix: a worktree may live *inside* the Principal
  // (`.claude/worktrees/<slug>`), and a prefix test would call it the Principal.
  if (here === principal) {
    if (head === null) {
      throw new TypeError('resolveEntry: branch is required on the Principal — create ω first, then hop to its branch')
    }
    if (!head.includes('/')) {
      throw new TypeError(`resolveEntry: "${head}" is a base branch, not ω — hopping there lands back on the Principal`)
    }
    return { action: 'hop', reason: 'principal', cwd: here, branch: head, ticket: issue, command: `/wt ${head}` }
  }

  if (issue === null) return { action: 'frame', cwd: here, branch: head, ticket: null }

  const branchTicket = ticketOfBranch(head)
  if (branchTicket !== issue) {
    return { action: 'refuse', reason: 'branch-mismatch', cwd: here, branch: head, ticket: issue, branchTicket }
  }

  return { action: 'build', cwd: here, branch: head, ticket: issue }
}
