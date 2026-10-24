// ── Claims: which ticket a branch or a commit belongs to ──────────────────────

/** Branch convention: `<type>/<issue>-<slug>`. The ticket ends the segment. */
const BRANCH_TICKET = /^[^/]+\/(\d+)(?:-|$)/

/** The issue a branch name claims, or `null` when it claims none. */
export function ticketOfBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const match = BRANCH_TICKET.exec(branch)
  return match ? Number(match[1]) : null
}

export function resolveTicketBranch(branch: string, children: number[]): { ticket: number } | { error: string } {
  const ticket = ticketOfBranch(branch)
  if (ticket === null) return { error: 'no ticket' }
  if (!children.includes(ticket)) return { error: 'foreign ticket' }
  return { ticket }
}

/** `feat(x): subject (#N)`, and the `Revert "… (#N)"` git writes for it. */
const SUBJECT_TICKET = /\(#(\d+)\)"*\s*$/

export function ticketOfSubject(subject: string): number | null {
  const match = SUBJECT_TICKET.exec(subject)
  return match ? Number(match[1]) : null
}

/** A commit that claims no ticket, or another one, is foreign: fail closed. */
export function refuseForeignCommits(
  commits: { sha: string; ticket: number | null }[],
  ticket: number,
): { ok: true } | { error: string } {
  const foreign = commits.find((commit) => commit.ticket !== ticket)
  if (foreign) return { error: `foreign commit ${foreign.sha}` }
  return { ok: true }
}
