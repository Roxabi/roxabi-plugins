const BRANCH_TICKET = /^[^/]+\/(\d+)(?:-|$)/

/** The issue a branch name claims, or `null` when it claims none. */
export function ticketOfBranch(branch: string | null | undefined): number | null {
  if (!branch) return null
  const match = BRANCH_TICKET.exec(branch)
  return match ? Number(match[1]) : null
}

const BRANCH_TYPES: Record<string, true> = {
  feat: true,
  fix: true,
  docs: true,
  test: true,
  chore: true,
  ci: true,
  perf: true,
  refactor: true,
}

const TITLE = /^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/

/** The Conventional type a title declares (`fix(scope)!: …` → `fix`), or null for none or an unknown one. */
function titleType(title: string): string | null {
  const prefix = TITLE.exec(title)?.[1]?.toLowerCase() ?? ''
  return Object.hasOwn(BRANCH_TYPES, prefix) ? prefix : null
}

/** A closing ticket's type signals as the tracker carries them. */
export type TicketSignals = { title: string; labels: string[]; issueType: string | null }

const FIX_TYPES: Record<string, true> = { fix: true, bug: true }

/** Whether the branch or its closing tickets establishes a fix, another kind, or neither. */
export function fixKind(head: string, tickets: TicketSignals[]): 'fix' | 'other' | 'unknown' {
  const branch = /^([^/]+)\//.exec(head)?.[1]?.toLowerCase() ?? ''
  const types = [
    Object.hasOwn(BRANCH_TYPES, branch) ? branch : null,
    ...tickets.flatMap((ticket) => [
      titleType(ticket.title),
      ticket.issueType?.toLowerCase() ?? null,
      ticket.labels.some((label) => label.toLowerCase() === 'bug') ? 'fix' : null,
    ]),
  ]
  if (types.some((type) => type !== null && Object.hasOwn(FIX_TYPES, type))) return 'fix'
  return types.some((type) => type !== null) ? 'other' : 'unknown'
}
