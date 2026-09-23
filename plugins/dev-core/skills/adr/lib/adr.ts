/**
 * ADR frontmatter contract — the executable half of
 * `references/adr-template.md`.
 *
 * The template file is the single definition of the fields and the status
 * vocabulary; this module is the only code that reads and writes them. A guard
 * test asserts the vocabulary here is set-equal to the template's, so the two
 * cannot drift.
 *
 * Write format is always Markdown (.md). Legacy .mdx ADRs are read for scan,
 * list and migrate; nothing ever writes .mdx.
 */

import type { Dirent } from 'node:fs'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Closed, lowercase status vocabulary. Set-equal to the template's. */
export const ADR_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'] as const

export type AdrStatus = (typeof ADR_STATUSES)[number]

/** Statuses whose ADR no longer carries binding authority. */
export const NON_NORMATIVE_STATUSES: readonly AdrStatus[] = ['deprecated', 'superseded']

/** Directory name, under the ADR root, holding superseded ADRs. */
export const ARCHIVE_DIR = 'archived'

/** Canonical frontmatter key order. Unknown keys keep their position. */
const KEY_ORDER = ['title', 'description', 'status', 'normative', 'date', 'superseded_by', 'axial']

const ADR_FILE_RE = /^(\d+)-.*\.(md|mdx)$/

export function isAdrStatus(value: string): value is AdrStatus {
  return (ADR_STATUSES as readonly string[]).includes(value)
}

/** `normative` is derived, never independently authored. */
export function normativeFor(status: AdrStatus): boolean {
  return !NON_NORMATIVE_STATUSES.includes(status)
}

export interface AdrFile {
  /** Absolute path on disk. */
  path: string
  /** Filename. */
  name: string
  /** Numeric sequence, parsed from the filename prefix. */
  nnn: number
  /** Width of the filename's zero-padded prefix (3 for `001`, 4 for `0001`). */
  width: number
  /** True when the file lives under `archived/`. */
  archived: boolean
  /** Parsed frontmatter, raw string values. */
  fields: Record<string, string>
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** Index of the closing `---` of a leading frontmatter block, or -1. */
function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== '---') return -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return i
  }
  return -1
}

/**
 * Parse the leading YAML frontmatter block — the flat `key: value` subset ADRs
 * use, plus `>`/`|` block scalars (folded into one space-joined line).
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split('\n')
  const end = frontmatterEnd(lines)
  if (end < 0) return {}

  const fields: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(lines[i])
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) {
        parts.push(lines[++i].trim())
      }
      value = parts.join(' ')
    }
    fields[key] = unquote(value)
  }
  return fields
}

function unquote(value: string): string {
  if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) return value.slice(1, -1)
  if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) return value.slice(1, -1)
  return value
}

/**
 * Set or remove frontmatter keys, in place, preserving every untouched line
 * (including folded block scalars). `null` removes the key. Missing keys are
 * inserted in canonical order.
 */
export function setFrontmatter(text: string, updates: Record<string, string | null>): string {
  const lines = text.split('\n')
  let end = frontmatterEnd(lines)
  if (end < 0) {
    // No frontmatter block: open one above the existing body.
    lines.unshift('---', '---', '')
    end = 1
  }

  for (const [key, value] of Object.entries(updates)) {
    const at = findKeyLine(lines, end, key)
    if (at >= 0) {
      const span = continuationEnd(lines, end, at)
      if (value === null) {
        lines.splice(at, span - at + 1)
        end -= span - at + 1
      } else {
        lines.splice(at, span - at + 1, `${key}: ${value}`)
        end -= span - at
      }
      continue
    }
    if (value === null) continue
    const at2 = insertionPoint(lines, end, key)
    lines.splice(at2, 0, `${key}: ${value}`)
    end += 1
  }

  return lines.join('\n')
}

function findKeyLine(lines: string[], end: number, key: string): number {
  for (let i = 1; i < end; i++) {
    if (new RegExp(`^${key}:\\s?`).test(lines[i])) return i
  }
  return -1
}

/** Last line of a key's value, following folded-scalar continuation lines. */
function continuationEnd(lines: string[], end: number, at: number): number {
  let last = at
  while (last + 1 < end && /^\s+\S/.test(lines[last + 1])) last++
  return last
}

/** Insert a new key after the last canonical key that precedes it. */
function insertionPoint(lines: string[], end: number, key: string): number {
  const rank = KEY_ORDER.indexOf(key)
  if (rank < 0) return end
  for (let before = rank - 1; before >= 0; before--) {
    const at = findKeyLine(lines, end, KEY_ORDER[before])
    if (at >= 0) return continuationEnd(lines, end, at) + 1
  }
  return 1
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Every ADR under `dir`, **including `archived/`**.
 *
 * Recursion is load-bearing: create mode derives the next NNN from this scan,
 * so an archived ADR that fell out of it would have its number handed to a new,
 * unrelated decision, and `ADR-0003` would name two things.
 */
export function scanAdrs(dir: string): AdrFile[] {
  if (!existsSync(dir)) return []
  const out: AdrFile[] = []
  collect(dir, dir, out)
  return out.sort((a, b) => a.nnn - b.nnn || a.name.localeCompare(b.name))
}

function collect(dir: string, root: string, out: AdrFile[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, root, out)
      continue
    }
    if (!entry.isFile()) continue
    const m = ADR_FILE_RE.exec(entry.name)
    if (!m) continue
    let text = ''
    try {
      text = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    out.push({
      path: full,
      name: entry.name,
      nnn: Number.parseInt(m[1], 10),
      width: m[1].length,
      archived: dir !== root,
      fields: parseFrontmatter(text),
    })
  }
}

/**
 * Next sequence number: highest existing + 1, over the **recursive** scan.
 * Padding follows the widest prefix in use (min 3), so a repo on `0001` keeps
 * getting 4-digit numbers and a repo on `001` keeps getting 3-digit ones.
 */
export function nextNnn(dir: string): string {
  const adrs = scanAdrs(dir)
  const highest = adrs.reduce((max, a) => Math.max(max, a.nnn), 0)
  const width = adrs.reduce((max, a) => Math.max(max, a.width), 3)
  return String(highest + 1).padStart(width, '0')
}

/** The ADR carrying `axial: true`, across active and archived. */
export function axialAdrs(dir: string): AdrFile[] {
  return scanAdrs(dir).filter((a) => a.fields.axial === 'true')
}

export interface AdrListing {
  active: AdrFile[]
  archived: AdrFile[]
}

/** List mode: active ADRs and archived ones, presented separately. */
export function listAdrs(dir: string): AdrListing {
  const all = scanAdrs(dir)
  return {
    active: all.filter((a) => !a.archived),
    archived: all.filter((a) => a.archived),
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

export interface TransitionResult {
  /** Path before the transition. */
  from: string
  /** Path after the transition (equal to `from` when nothing moved). */
  to: string
  status: AdrStatus
  /** True when `axial: true` was stripped to keep the singleton invariant. */
  axialStripped: boolean
}

/**
 * Supersede: flip status, record the replacement, drop binding authority, strip
 * the axial marker, and move the file under `archived/`.
 */
export function supersedeAdr(adr: AdrFile, supersededBy: string, dir: string): TransitionResult {
  const text = readFileSync(adr.path, 'utf-8')
  const axialStripped = adr.fields.axial === 'true'
  const updates: Record<string, string | null> = {
    status: 'superseded',
    normative: 'false',
    superseded_by: supersededBy,
  }
  if (axialStripped) updates.axial = null
  const next = stripStatusSection(setFrontmatter(text, updates))

  const target = join(dir, ARCHIVE_DIR, adr.name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(adr.path, next)
  if (target !== adr.path) renameSync(adr.path, target)

  return { from: adr.path, to: target, status: 'superseded', axialStripped }
}

/**
 * Deprecate: same loss of binding authority, but the file stays put. Deprecated
 * is not replaced, so there is no successor to archive it behind.
 */
export function deprecateAdr(adr: AdrFile): TransitionResult {
  const text = readFileSync(adr.path, 'utf-8')
  const next = stripStatusSection(setFrontmatter(text, { status: 'deprecated', normative: 'false' }))
  writeFileSync(adr.path, next)
  return { from: adr.path, to: adr.path, status: 'deprecated', axialStripped: false }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** First non-empty line of the `## Status` body section, or null. */
export function readStatusSection(text: string): string | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Status\s*$/i.test(lines[i])) continue
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) {
      if (lines[j].trim()) return lines[j].trim()
    }
    return ''
  }
  return null
}

/** Drop the `## Status` section — status lives in frontmatter, once. */
export function stripStatusSection(text: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^##\s+Status\s*$/i.test(l))
  if (start < 0) return text
  let end = start + 1
  while (end < lines.length && !/^##\s/.test(lines[end])) end++
  lines.splice(start, end - start)
  return lines.join('\n')
}

export interface StatusReading {
  status: AdrStatus
  supersededBy: string | null
  date: string | null
}

/**
 * Read a body `## Status` line into the frontmatter contract's terms.
 *
 * The replacement is only read when the ADR is itself superseded — plenty of
 * in-force ADRs say "Accepted. Partially superseded by ADR-015 for X", and
 * that sentence must not make the ADR claim to be replaced.
 */
export function interpretStatusLine(line: string): StatusReading | null {
  const word = /^[A-Za-z]+/.exec(line.trim())?.[0]?.toLowerCase()
  if (!word || !isAdrStatus(word)) return null
  const target = word === 'superseded' ? /superseded\s+by\s+\[?ADR-(\d+)/i.exec(line) : null
  return {
    status: word,
    supersededBy: target ? `ADR-${target[1]}` : null,
    date: /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1] ?? null,
  }
}

export interface MigrationReport {
  path: string
  /** False when the ADR already satisfied the contract. */
  changed: boolean
  status: AdrStatus | null
  normative: boolean | null
  date: string | null
  supersededBy: string | null
  /** Anything a human must resolve before the corpus is contract-clean. */
  warnings: string[]
}

export interface MigrateOpts {
  /** Fallback decision date per path, e.g. from git history. */
  dates?: Record<string, string>
  /** Report only; do not write. */
  dryRun?: boolean
}

/**
 * Backfill `status` / `normative` / `date` from the body `## Status` section,
 * then drop that section. Never invents a `superseded_by` it cannot read.
 */
export function migrateAdrFile(path: string, opts: MigrateOpts = {}): MigrationReport {
  const text = readFileSync(path, 'utf-8')
  const fields = parseFrontmatter(text)
  const warnings: string[] = []
  const line = readStatusSection(text)

  let reading: StatusReading | null = null
  if (line === null) {
    if (!fields.status) warnings.push('no `## Status` section and no `status` field — status unknown')
  } else if (line === '') {
    warnings.push('`## Status` section is empty — status unknown')
  } else {
    reading = interpretStatusLine(line)
    if (!reading) warnings.push(`unrecognised status line: ${truncate(line)}`)
  }

  const existing = fields.status && isAdrStatus(fields.status) ? fields.status : null
  const status = existing ?? reading?.status ?? null
  const date = fields.date || reading?.date || opts.dates?.[path] || null
  const supersededBy = fields.superseded_by || reading?.supersededBy || null

  if (status === 'superseded' && !supersededBy) {
    warnings.push('status `superseded` with no readable replacement — `superseded_by` needs a human')
  }
  if (!date) warnings.push('no decision date found — `date` needs a human')

  const updates: Record<string, string | null> = {}
  if (status) {
    updates.status = status
    updates.normative = String(normativeFor(status))
  }
  if (date) updates.date = date
  if (status === 'superseded' && supersededBy) updates.superseded_by = supersededBy

  const alreadyClean =
    Boolean(fields.status) &&
    Boolean(fields.normative) &&
    Boolean(fields.date) &&
    line === null &&
    (status !== 'superseded' || Boolean(fields.superseded_by))

  if (!alreadyClean && !opts.dryRun && status) {
    writeFileSync(path, stripStatusSection(setFrontmatter(text, updates)))
  }

  return {
    path,
    changed: !alreadyClean && status !== null,
    status,
    normative: status ? normativeFor(status) : null,
    date,
    supersededBy,
    warnings,
  }
}

function truncate(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value
}

/** Migrate every ADR under `dir`, archived included. */
export function migrateAdrDir(dir: string, opts: MigrateOpts = {}): MigrationReport[] {
  return scanAdrs(dir).map((a) => migrateAdrFile(a.path, opts))
}
