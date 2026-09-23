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
const KEY_ORDER = [
  'title',
  'description',
  'status',
  'normative',
  'date',
  'superseded_by',
  'superseded_in_part_by',
  'axial',
]

/**
 * An ADR filename: `{NNN}-{slug}.md|.mdx`, NNN zero-padded to 3 or 4 digits.
 *
 * The width bound and the date exclusion below are load-bearing for number
 * allocation, not cosmetics. `nextNnn` is `max(nnn) + 1` over this scan, so a
 * file the pattern wrongly admits sets the next number. An unbounded `\d+`
 * prefix admitted `2026-08-24-notes.md` sitting beside 001-005 and allocated
 * `2027` — silently, because nothing downstream questions a maximum.
 */
const ADR_FILE_RE = /^(\d{3,4})-[^/]*\.(md|mdx)$/

/** `YYYY-MM-DD-` — a dated note, never a decision number. */
const DATED_NOTE_RE = /^\d{4}-\d{2}-\d{2}-/

/** Looks like it wants to be an ADR: leading digits, markdown extension. */
const ADR_SHAPED_RE = /^\d[^/]*\.(md|mdx)$/

/**
 * Parse an ADR filename. `null` when the name is not an ADR.
 *
 * Exported because the hygiene gate implements the same predicate in bash and
 * a guard test holds the two to the same classification on the same corpus —
 * the readers disagreeing on *what an ADR is* is how `12.md` ended up bound by
 * one reader and invisible to the other.
 */
export function parseAdrName(name: string): { nnn: number; width: number } | null {
  if (DATED_NOTE_RE.test(name)) return null
  const m = ADR_FILE_RE.exec(name)
  if (!m) return null
  return { nnn: Number.parseInt(m[1], 10), width: m[1].length }
}

/**
 * A file that claims ADR shape (leading digit, `.md`/`.mdx`) but does not parse
 * as one. `12.md`, `2026-08-24-notes.md`, `00001-x.md`. Not silently skipped:
 * either it is a misnamed ADR that escapes the contract, or a note that would
 * poison number allocation, and both are reported.
 */
export function isMisnamedAdr(name: string): boolean {
  return ADR_SHAPED_RE.test(name) && parseAdrName(name) === null
}

/**
 * YAML 1.1 boolean spellings. `axial: True` and `axial: yes` are `true` to any
 * YAML parser, so a reader that tests for the literal string `'true'` reports
 * a declared axis as undeclared — which is precisely the signal `dev-init` and
 * the axial interview use to launch the interview that writes a *second* axial
 * ADR. Recognise every spelling on read; the gate still requires the canonical
 * one on disk so the corpus converges on one.
 */
export const YAML_BOOLEANS: Record<string, boolean> = {
  true: true,
  True: true,
  TRUE: true,
  y: true,
  Y: true,
  yes: true,
  Yes: true,
  YES: true,
  on: true,
  On: true,
  ON: true,
  false: false,
  False: false,
  FALSE: false,
  n: false,
  N: false,
  no: false,
  No: false,
  NO: false,
  off: false,
  Off: false,
  OFF: false,
}

/**
 * Read a YAML boolean in any spelling. `undefined` when the value is not a
 * boolean at all — distinct from `false`, which is an authored denial.
 */
export function yamlBoolean(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : YAML_BOOLEANS[value.trim()]
}

/**
 * A reference a partially-superseded ADR may name: a successor decision
 * (`ADR-015`) or the change that retired the mechanism without one (`#452`).
 *
 * Both shapes are admitted deliberately. An in-force ADR loses a part either to
 * a later decision or to a change that deleted the mechanism and recorded no
 * decision; forcing the second into the first shape is exactly the move that
 * falsified ADR-010 and ADR-014 — a record edited to fit the vocabulary the
 * gate offered, instead of a vocabulary wide enough to hold the truth.
 */
export const PARTIAL_REF_RE = /^(?:ADR-\d{3,4}|#\d+)$/

/** Parse a YAML flow sequence (`[ADR-015, #452]`) into trimmed entries. */
export function parseRefList(value: string | undefined): string[] {
  if (value === undefined) return []
  const inner = /^\[(.*)\]$/s.exec(value.trim())
  return (inner ? inner[1] : value)
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

export function isAdrStatus(value: string): value is AdrStatus {
  return (ADR_STATUSES as readonly string[]).includes(value)
}

/**
 * `normative` is derived, never independently authored.
 *
 * It answers *whether* the ADR carries binding authority, not *how much*: a
 * partially-superseded ADR is still law for the part nobody replaced, so it
 * stays `true` and names the replaced parts in `superseded_in_part_by`.
 * Flattening that to `false` would retire a record still in force; leaving it
 * `true` with no qualifier is what made `grep -l 'normative: true'` return
 * five records that are not wholly law.
 */
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

/** A number claimed by more than one document. */
export interface AdrCollision {
  nnn: number
  files: string[]
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
    const parsed = parseAdrName(entry.name)
    if (!parsed) continue
    let text = ''
    try {
      text = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    out.push({
      path: full,
      name: entry.name,
      nnn: parsed.nnn,
      width: parsed.width,
      archived: dir !== root,
      fields: parseFrontmatter(text),
    })
  }
}

/** Paths under `dir` that claim ADR shape but do not parse as an ADR. */
export function misnamedAdrs(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  collectMisnamed(dir, out)
  return out.sort()
}

function collectMisnamed(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      collectMisnamed(join(dir, entry.name), out)
      continue
    }
    if (entry.isFile() && isMisnamedAdr(entry.name)) out.push(join(dir, entry.name))
  }
}

/**
 * Numbers claimed by more than one document — `001-a.md` beside `0001-b.md`.
 *
 * The recursion fix stopped archiving from *freeing* a number. It did nothing
 * about a number that was handed out twice: one number naming two documents is
 * the same corruption arriving by a different route, and nothing looked for it.
 */
export function adrCollisions(dir: string): AdrCollision[] {
  const byNnn = new Map<number, string[]>()
  for (const adr of scanAdrs(dir)) {
    const bucket = byNnn.get(adr.nnn)
    if (bucket) bucket.push(adr.path)
    else byNnn.set(adr.nnn, [adr.path])
  }
  return [...byNnn.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([nnn, files]) => ({ nnn, files: files.sort() }))
    .sort((a, b) => a.nnn - b.nnn)
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

/**
 * The ADR carrying an axial declaration, across active and archived.
 *
 * Reads every YAML boolean spelling, not the literal `'true'`: a repo whose
 * axis is declared `axial: True` must not read as undeclared, because that is
 * the signal the interview uses to write a second one.
 */
export function axialAdrs(dir: string): AdrFile[] {
  return scanAdrs(dir).filter((a) => yamlBoolean(a.fields.axial) === true)
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
 *
 * `superseded_in_part_by` goes with it. That field qualifies a record still in
 * force ("binding except for these parts"); on a record that is wholly replaced
 * it is a contradiction, and the gate rejects it as one.
 */
export function supersedeAdr(adr: AdrFile, supersededBy: string, dir: string): TransitionResult {
  const text = readFileSync(adr.path, 'utf-8')
  const axialStripped = yamlBoolean(adr.fields.axial) === true
  const updates: Record<string, string | null> = {
    status: 'superseded',
    normative: 'false',
    superseded_by: supersededBy,
    superseded_in_part_by: null,
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
 * Supersede *in part*: the ADR stays in force and stays where it is; it gains
 * one more entry in `superseded_in_part_by`.
 *
 * This is the transition the vocabulary was missing. Without it the only way to
 * record "in force except X" was prose, and prose is not authoritative under
 * this contract — so the choice on offer was to flatten a partially-replaced
 * ADR to plain `accepted` (losing the exception) or to `superseded` (retiring a
 * record still in force). Both are false; this is neither.
 */
export function supersedeAdrInPart(adr: AdrFile, by: string): TransitionResult {
  const text = readFileSync(adr.path, 'utf-8')
  const refs = parseRefList(adr.fields.superseded_in_part_by)
  if (!refs.includes(by)) refs.push(by)
  const status = adr.fields.status && isAdrStatus(adr.fields.status) ? adr.fields.status : 'accepted'
  const next = setFrontmatter(text, {
    status,
    normative: String(normativeFor(status)),
    superseded_in_part_by: `[${refs.join(', ')}]`,
  })
  writeFileSync(adr.path, next)
  return { from: adr.path, to: adr.path, status, axialStripped: false }
}

/**
 * Deprecate: same loss of binding authority, but the file stays put. Deprecated
 * is not replaced, so there is no successor to archive it behind.
 */
export function deprecateAdr(adr: AdrFile): TransitionResult {
  const text = readFileSync(adr.path, 'utf-8')
  const next = stripStatusSection(
    setFrontmatter(text, { status: 'deprecated', normative: 'false', superseded_in_part_by: null }),
  )
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

/**
 * The whole `## Status` section, or null.
 *
 * `status` and `date` are read off the opening line, but a partial-supersession
 * qualifier is routinely a *later* line — ADR-019 opens "Accepted — 2026-08-21"
 * and narrows itself two lines down. Scanning only the first line drops the
 * qualifier while reporting success, which is the loss this field exists to
 * prevent.
 */
export function readStatusSectionBody(text: string): string | null {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^##\s+Status\s*$/i.test(lines[i])) continue
    const body: string[] = []
    for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) body.push(lines[j])
    return body.join('\n').trim()
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
  /** References named as replacing *part* of a still-in-force ADR. */
  supersededInPartBy: string[]
  /** The decision date, when the line carries one that can be that date. */
  date: string | null
  /** The date the decision stopped applying, on a `superseded`/`deprecated` line. */
  endedDate: string | null
}

/** "Partially superseded by ADR-015", "Narrowed 2026-09-21 by ADR-020", "Amended by #268". */
const PARTIAL_PROSE_RE =
  /\b(?:partially\s+superseded|partly\s+superseded|narrowed|amended)\b[^.]{0,80}?\bby\s+(?:\[?ADR-(\d{1,4})|#(\d+))/gi

/**
 * Read a body `## Status` line into the frontmatter contract's terms.
 *
 * The replacement is only read when the ADR is itself superseded — plenty of
 * in-force ADRs say "Accepted. Partially superseded by ADR-015 for X", and
 * that sentence must not make the ADR claim to be replaced. That same sentence
 * *is* read into `superseded_in_part_by`, which is what it actually says.
 *
 * The date is read as the decision date only on a status that is still in
 * force. On "Superseded — 2026-08-24" the date is when the decision *stopped*
 * applying; recording it as `date` backdates the ADR's authorship to its own
 * retirement, silently, and the template defines `date` as the decision date.
 */
export function interpretStatusLine(line: string, section: string = line): StatusReading | null {
  const word = /^[A-Za-z]+/.exec(line.trim())?.[0]?.toLowerCase()
  if (!word || !isAdrStatus(word)) return null
  const target = word === 'superseded' ? /superseded\s+by\s+\[?ADR-(\d+)/i.exec(line) : null
  const inPart: string[] = []
  for (const m of section.matchAll(PARTIAL_PROSE_RE)) {
    const ref = m[1] ? `ADR-${m[1].padStart(3, '0')}` : `#${m[2]}`
    if (!inPart.includes(ref)) inPart.push(ref)
  }
  const firstDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1] ?? null
  const inForce = normativeFor(word)
  return {
    status: word,
    supersededBy: target ? `ADR-${target[1]}` : null,
    supersededInPartBy: inForce ? inPart : [],
    date: inForce ? firstDate : null,
    endedDate: inForce ? null : firstDate,
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
  supersededInPartBy: string[]
  /** Anything a human must resolve before the corpus is contract-clean. */
  warnings: string[]
}

export interface MigrateOpts {
  /** Fallback decision date per path, e.g. from git history. */
  dates?: Record<string, string>
  /** Report only; do not write. */
  dryRun?: boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Backfill the frontmatter contract from the body `## Status` section, then
 * drop that section. Never invents a value it cannot read.
 *
 * **`changed` is decided by comparing the file to the state the contract
 * requires, never by asking whether a field is present.** Testing presence is
 * how the migrator came to answer `changed: false, clean: true` on a file whose
 * own report said `normative: false` while the file on disk said `true`: the
 * gate reported a violation, the gate's prescribed remedy declared the file
 * clean, and the violation survived. Every violation this migrator can derive a
 * fix for is fixed; every one it cannot is a warning, so `clean: false` and the
 * gate's red agree on the same corpus.
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
    reading = interpretStatusLine(line, readStatusSectionBody(text) ?? line)
    if (!reading) warnings.push(`unrecognised status line: ${truncate(line)}`)
  }

  // A status is a closed-set token, so case is spelling, not meaning:
  // `Accepted` is normalised. Anything outside the set is reported, never
  // guessed — and never silently left in place for the gate to reject alone.
  const authored = fields.status?.trim().toLowerCase()
  if (fields.status && !(authored && isAdrStatus(authored))) {
    warnings.push(`status '${fields.status}' is not in the vocabulary (${ADR_STATUSES.join(' ')}) — needs a human`)
  }
  const existing = authored && isAdrStatus(authored) ? authored : null
  const status = existing ?? reading?.status ?? null

  if (fields.date && !ISO_DATE_RE.test(fields.date.trim())) {
    warnings.push(`date '${fields.date}' is not YYYY-MM-DD — needs a human`)
  }
  // Git's first-commit date outranks a date scraped from status prose for every
  // status whose prose date is a *retirement* date; `reading.date` is already
  // null in that case, so the order below never prefers one over the other.
  const authoredDate = fields.date && ISO_DATE_RE.test(fields.date.trim()) ? fields.date.trim() : null
  const date = authoredDate ?? reading?.date ?? opts.dates?.[path] ?? null

  const supersededBy = fields.superseded_by || reading?.supersededBy || null
  const inPart = fields.superseded_in_part_by
    ? parseRefList(fields.superseded_in_part_by)
    : (reading?.supersededInPartBy ?? [])

  if (status === 'superseded' && !supersededBy) {
    warnings.push('status `superseded` with no readable replacement — `superseded_by` needs a human')
  }
  if (status && status !== 'superseded' && fields.superseded_by) {
    warnings.push(`\`superseded_by\` present but status is '${status}' — one of the two is wrong, needs a human`)
  }
  if (status && !normativeFor(status) && inPart.length > 0) {
    warnings.push(`\`superseded_in_part_by\` on a '${status}' ADR — a replaced record has no parts left in force`)
  }
  for (const ref of inPart) {
    if (!PARTIAL_REF_RE.test(ref)) {
      warnings.push(`\`superseded_in_part_by\` entry '${ref}' is not an \`ADR-NNN\` or \`#NNN\` reference`)
    }
  }
  if (!date) warnings.push('no decision date found — `date` needs a human')
  if (date && reading?.endedDate && date > reading.endedDate) {
    warnings.push(
      `decision date ${date} is after the ${status} date ${reading.endedDate} — one of the two is wrong, needs a human`,
    )
  }
  const axialSpelling = fields.axial?.trim()
  if (axialSpelling !== undefined && yamlBoolean(axialSpelling) !== undefined && axialSpelling !== 'true') {
    warnings.push(`\`axial: ${axialSpelling}\` is a YAML boolean alias — the contract spells it \`true\``)
  }

  const updates: Record<string, string | null> = {}
  if (status) {
    updates.status = status
    updates.normative = String(normativeFor(status))
  }
  if (date) updates.date = date
  if (status === 'superseded' && supersededBy) updates.superseded_by = supersededBy
  if (status && normativeFor(status) && inPart.length > 0) {
    updates.superseded_in_part_by = `[${inPart.join(', ')}]`
  }
  if (yamlBoolean(axialSpelling) === true && axialSpelling !== 'true') updates.axial = 'true'

  // Clean ⟺ the file already *is* the state the contract requires. Not
  // "carries the keys": carrying `normative: true` on a superseded ADR is the
  // exact violation the gate prints.
  const alreadyClean = line === null && Object.entries(updates).every(([key, value]) => fields[key] === value)

  if (!alreadyClean && !opts.dryRun && (status || line !== null)) {
    writeFileSync(path, stripStatusSection(setFrontmatter(text, updates)))
  }

  return {
    path,
    changed: !alreadyClean && (status !== null || line !== null),
    status,
    normative: status ? normativeFor(status) : null,
    date,
    supersededBy,
    supersededInPartBy: inPart,
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
