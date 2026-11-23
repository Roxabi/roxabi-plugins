// ── Branch naming ─────────────────────────────────────────────────────────────

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
