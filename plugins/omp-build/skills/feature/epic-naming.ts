// ── Scope and branch naming ───────────────────────────────────────────────────

/** Markdown headings outside fenced code. */
function headings(body: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of body.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced
    else if (!fenced && /^ {0,3}#{1,6}\s/.test(line)) out.push(line)
  }
  return out
}

/**
 * Framed enough to start unattended: a `size:` label, an acceptance/criteria
 * heading, and no heading containing "needs framing" (the §4 not-framed marker).
 */
export function hasScope(child: { labels: string[]; body: string }): boolean {
  const titles = headings(child.body)
  return (
    child.labels.some((label) => label.startsWith('size:')) &&
    titles.some((title) => /acceptance|criteria/i.test(title)) &&
    !titles.some((title) => /needs framing/i.test(title))
  )
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
export function titleType(title: string): string | null {
  const prefix = TITLE.exec(title)?.[1]?.toLowerCase() ?? ''
  return Object.hasOwn(BRANCH_TYPES, prefix) ? prefix : null
}

/** A closing ticket's type signals as the tracker carries them. */
export type TicketSignals = { title: string; labels: string[]; issueType: string | null }

const FIX_TYPES: Record<string, true> = { fix: true, bug: true }

/**
 * Whether a PR is a fix, from its head branch and the tickets it closes: `fix`
 * when any signal says so — a `fix/…` branch (`branchFor`'s name for a fix
 * ticket), a ticket's `fix` Conventional title, `bug` label, or Fix or Bug
 * issue type, in any case; `other` when a known branch type, title type or issue
 * type establishes another type; `unknown` when nothing establishes one.
 */
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

/** `<type>/<N>-<slug>` from the Conventional title (`bug` label → `fix`, else `feat`). */
export function branchFor(child: { number: number; title: string; labels: string[] }): string {
  const match = TITLE.exec(child.title)
  const type = titleType(child.title) ?? (child.labels.includes('bug') ? 'fix' : 'feat')
  const slug = (match ? (match[2] ?? '') : child.title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `${type}/${child.number}${slug ? `-${slug}` : ''}`
}

// ── Mandate identity ──────────────────────────────────────────────────────────

export const RUN_ID = /^[a-z0-9]{8}$/
/** A branch name, not a revision (`..`, `~`, `^`, `@{`, `:` are excluded). */
export const BASE_NAME = /^(?!.*(?:\.\.|~|\^|@\{|:))[A-Za-z0-9._/-]+$/
