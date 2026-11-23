// ── Claims: which ticket a branch or a commit belongs to ──────────────────────

/** Branch convention: `<type>/<issue>-<slug>`. The ticket ends the segment. */
const BRANCH_TICKET = /^[^/]+\/(\d+)(?:-|$)/

/** The issue a branch name claims, or `null` when it claims none. */
export function ticketOfBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const match = BRANCH_TICKET.exec(branch)
  return match ? Number(match[1]) : null
}

/** `feat(x): subject (#N)`, and the `Revert "… (#N)"` git writes for it. */
const SUBJECT_TICKET = /\(#(\d+)\)"*\s*$/

export function ticketOfSubject(subject: string): number | null {
  const match = SUBJECT_TICKET.exec(subject)
  return match ? Number(match[1]) : null
}
