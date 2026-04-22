/**
 * migrate.ts — taxonomy migration subcommands: audit-schema, backfill, rewrite-titles, revert.
 * See artifacts/specs/121-dual-write-migration-spec.mdx.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_LANE_OPTIONS,
  GH_PROJECT_ID,
  LANE_FIELD_ID,
  LANE_OPTIONS,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
  STATUS_OPTIONS,
} from '../../shared/adapters/config-helpers'
import {
  clearField,
  ghGraphQL,
  listOrgIssueTypes,
  run,
  updateField,
  updateIssueIssueType,
} from '../../shared/adapters/github-adapter'

// ---------------------------------------------------------------------------
// Repo-root-anchored migrationDir (fix #3: CWD-relative → anchor to repo root)
// ---------------------------------------------------------------------------

const __dir = path.dirname(fileURLToPath(import.meta.url))
// migrate.ts lives at plugins/dev-core/skills/issue-triage/lib — repo root is 5 levels up
const REPO_ROOT = path.resolve(__dir, '..', '..', '..', '..', '..', '..')
const migrationDir = path.join(REPO_ROOT, 'artifacts', 'migration')

// ---------------------------------------------------------------------------
// Path-traversal guard for --snapshot (fix #2)
// ---------------------------------------------------------------------------

export function validateSnapshotPath(p: string, allowedDir?: string): string {
  const resolved = path.resolve(p)
  const allowed = path.resolve(allowedDir ?? migrationDir)
  if (!resolved.startsWith(allowed + path.sep) && resolved !== allowed) {
    console.error(`Error: --snapshot path must be within ${allowed}`)
    process.exit(1)
  }
  return resolved
}

interface FieldSchema {
  id: string
  name: string
  options: Array<{ id: string; name: string }>
}

const PROJECT_FIELDS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options { id name }
            }
          }
        }
      }
    }
  }
`

const EXPECTED_FIELDS: Array<{ name: string; options: Record<string, string> }> = [
  { name: 'Size', options: SIZE_OPTIONS },
  { name: 'Lane', options: LANE_OPTIONS },
  { name: 'Priority', options: PRIORITY_OPTIONS },
  { name: 'Status', options: STATUS_OPTIONS },
]

export async function auditSchema(): Promise<void> {
  // fix #10: wrap ghGraphQL in try/catch
  let data: {
    node: {
      fields: {
        nodes: Array<Partial<FieldSchema>>
      }
    }
  }
  try {
    data = (await ghGraphQL(PROJECT_FIELDS_QUERY, { projectId: GH_PROJECT_ID })) as typeof data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: audit-schema failed to query project. Check GH_PROJECT_ID and GH token. Underlying: ${msg}`)
    process.exit(1)
  }

  const liveNodes = data.node.fields.nodes.filter((n): n is FieldSchema => Array.isArray((n as FieldSchema).options))

  const liveByName = new Map<string, FieldSchema>(liveNodes.map((n) => [n.name, n]))

  const diffs: string[] = []

  for (const expected of EXPECTED_FIELDS) {
    const liveField = liveByName.get(expected.name)

    if (!liveField) {
      diffs.push(`MISSING: ${expected.name}`)
      continue
    }

    const liveOptionNames = new Set(liveField.options.map((o) => o.name))
    const localOptionNames = new Set(Object.keys(expected.options))

    for (const local of localOptionNames) {
      if (!liveOptionNames.has(local)) {
        diffs.push(`LOCAL_EXTRA: ${expected.name}.${local}`)
      }
    }

    for (const live of liveOptionNames) {
      if (!localOptionNames.has(live)) {
        diffs.push(`LOCAL_MISSING: ${expected.name}.${live}`)
      }
    }
  }

  if (diffs.length > 0) {
    for (const line of diffs) {
      console.log(line)
    }
    process.exit(1)
  }

  console.log('audit-schema: OK — Size/Lane/Priority/Status match live project')
}

// ---------------------------------------------------------------------------
// LEGACY_LABEL_MAP — maps label-derived tokens to canonical project field values
// ---------------------------------------------------------------------------

export const LEGACY_LABEL_MAP = {
  lane: Object.fromEntries(DEFAULT_LANE_OPTIONS.map((l) => [l, l])) as Record<string, string>,
  size: {
    // XS → S: collapsed to smallest new-schema bucket; XS has no equivalent in S/F-lite/F-full
    XS: 'S',
    S: 'S',
    M: 'F-lite',
    L: 'F-full',
    XL: 'F-full',
  } as Record<string, string>,
  priority: {
    P0: 'P0 - Urgent',
    P1: 'P1 - High',
    P2: 'P2 - Medium',
    P3: 'P3 - Low',
  } as Record<string, string>,
  issueType: {
    feat: 'feat',
    fix: 'fix',
    docs: 'docs',
    test: 'test',
    chore: 'chore',
    ci: 'ci',
    perf: 'perf',
    refactor: 'refactor',
  } as Record<string, string>,
}

// ---------------------------------------------------------------------------
// TITLE_PREFIX_RE — extract conventional-commit type from issue title
// ---------------------------------------------------------------------------

export const TITLE_PREFIX_RE = /^(feat|fix|refactor|docs|test|chore|ci|perf)(\(.+?\))?:\s*/

// ---------------------------------------------------------------------------
// Backfill types
// ---------------------------------------------------------------------------

interface GhIssueListItem {
  number: number
  title: string
  labels: Array<{ name: string }>
  id: string
}

interface ProjectItemFieldValues {
  fieldValues: {
    nodes: Array<{
      name?: string
      field?: { name?: string }
    }>
  }
}

interface Row {
  repo: string
  number: number
  field: string
  old_value: string | null
  new_value: string | null
  flagged: boolean
}

interface FlaggedEntry {
  repo: string
  number: number
  title: string
  field: string
  observed: string
}

interface LegacyValues {
  lane?: string
  size?: string
  priority?: string
  issueType?: string
}

// ---------------------------------------------------------------------------
// Snapshot envelope types (fix #12)
// ---------------------------------------------------------------------------

interface BackfillSnapshot {
  kind: 'backfill'
  generatedAt: string
  rows: BackfillRow[]
}

interface RewriteSnapshot {
  kind: 'rewrite'
  generatedAt: string
  rows: RewriteRow[]
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const ITEM_FIELDS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        id
        issueType { id name }
        projectItems(first: 10) {
          nodes {
            id
            project { id }
            fieldValues(first: 20) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`

function extractLegacyValues(issue: GhIssueListItem): LegacyValues {
  const values: LegacyValues = {}

  for (const label of issue.labels) {
    const laneMatch = label.name.match(/^graph:lane\/(.+)$/)
    if (laneMatch) {
      values.lane = laneMatch[1]
      continue
    }

    const sizeMatch = label.name.match(/^size:(.+)$/)
    if (sizeMatch) {
      values.size = sizeMatch[1]
      continue
    }

    const priorityMatch = label.name.match(/^(P[0-3])-/)
    if (priorityMatch) {
      values.priority = priorityMatch[1]
    }
  }

  const titleMatch = issue.title.match(TITLE_PREFIX_RE)
  if (titleMatch) {
    values.issueType = titleMatch[1]
  }

  return values
}

function formatTimestamp(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}`
}

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------

export async function backfill(opts: { repo: string; dryRun: boolean; snapshotPath?: string }): Promise<void> {
  await auditSchema()

  const [owner, repoName] = opts.repo.split('/')

  // fix #1: execFileSync instead of execSync (shell injection guard)
  const issuesJson = execFileSync(
    'gh',
    ['issue', 'list', '--repo', opts.repo, '--state', 'open', '--limit', '1000', '--json', 'number,title,labels,id'],
    { encoding: 'utf-8' },
  )
  const issues = JSON.parse(issuesJson) as GhIssueListItem[]

  // fix #5: warn when limit ceiling is hit
  if (issues.length >= 1000) {
    const ts = formatTimestamp()
    console.warn(`Warning: hit --limit 1000 ceiling on repo ${opts.repo}; some issues may be truncated`)
    mkdirSync(migrationDir, { recursive: true })
    const flaggedFile = join(migrationDir, `flagged-${ts}.txt`)
    await writeFile(
      flaggedFile,
      `DIAGNOSTIC: hit --limit 1000 ceiling on repo ${opts.repo} at ${new Date().toISOString()} — some issues may be truncated\n`,
      'utf-8',
    )
  }

  const rows: Row[] = []
  const flagged: FlaggedEntry[] = []
  let updated = 0
  let skipped = 0

  // fix #4: pre-resolve issue type IDs once (N+1 guard)
  const org = opts.repo.split('/')[0]
  const orgTypes = await listOrgIssueTypes(org)
  const typeIdByName = new Map<string, string>(orgTypes.map((t) => [t.name.toLowerCase(), t.id]))

  for (const issue of issues) {
    // Fetch project item field values
    let fetchResult:
      | { itemId: string; issueNodeId: string; currentFields: Record<string, string>; currentIssueType?: string }
      | undefined

    try {
      const data = (await ghGraphQL(ITEM_FIELDS_QUERY, {
        owner,
        repo: repoName,
        number: issue.number,
      })) as {
        repository: {
          issue: {
            id: string
            issueType: { id: string; name: string } | null
            projectItems: {
              nodes: Array<{
                id: string
                project: { id: string }
                fieldValues: ProjectItemFieldValues['fieldValues']
              }>
            }
          }
        }
      }

      const issueData = data.repository.issue
      const projectItem = issueData.projectItems.nodes.find((n) => n.project.id === GH_PROJECT_ID)

      if (!projectItem) {
        flagged.push({
          repo: opts.repo,
          number: issue.number,
          title: issue.title,
          field: 'project',
          observed: 'not-in-project',
        })
        continue
      }

      const currentFields: Record<string, string> = {}
      for (const fv of projectItem.fieldValues.nodes) {
        if (fv.name && fv.field?.name) {
          currentFields[fv.field.name] = fv.name
        }
      }

      fetchResult = {
        itemId: projectItem.id,
        issueNodeId: issueData.id,
        currentFields,
        currentIssueType: issueData.issueType?.name,
      }
    } catch {
      flagged.push({
        repo: opts.repo,
        number: issue.number,
        title: issue.title,
        field: 'project',
        observed: 'fetch-error',
      })
      continue
    }

    const { itemId, issueNodeId, currentFields, currentIssueType } = fetchResult
    const legacyValues = extractLegacyValues(issue)

    // Process each field
    const fieldDefs: Array<{
      field: string
      currentValue: string | undefined
      legacyToken: string | undefined
      map: Record<string, string>
      apply: (canonical: string) => Promise<void>
    }> = [
      {
        field: 'Lane',
        currentValue: currentFields.Lane,
        legacyToken: legacyValues.lane,
        map: LEGACY_LABEL_MAP.lane,
        apply: async (canonical) => {
          await updateField(itemId, LANE_FIELD_ID, LANE_OPTIONS[canonical])
        },
      },
      {
        field: 'Size',
        currentValue: currentFields.Size,
        legacyToken: legacyValues.size,
        map: LEGACY_LABEL_MAP.size,
        apply: async (canonical) => {
          await updateField(itemId, SIZE_FIELD_ID, SIZE_OPTIONS[canonical])
        },
      },
      {
        field: 'Priority',
        currentValue: currentFields.Priority,
        legacyToken: legacyValues.priority,
        map: LEGACY_LABEL_MAP.priority,
        apply: async (canonical) => {
          await updateField(itemId, PRIORITY_FIELD_ID, PRIORITY_OPTIONS[canonical])
        },
      },
      {
        field: 'issueType',
        currentValue: currentIssueType,
        legacyToken: legacyValues.issueType,
        map: LEGACY_LABEL_MAP.issueType,
        // fix #4: use pre-resolved typeIdByName instead of per-issue resolveIssueTypeId
        apply: async (canonical) => {
          const typeId = typeIdByName.get(canonical.toLowerCase())
          if (!typeId) throw new Error(`Unknown issue type: ${canonical}`)
          await updateIssueIssueType(issueNodeId, typeId)
        },
      },
    ]

    for (const def of fieldDefs) {
      // fix #15: explicit non-null + non-empty-string check (idempotency)
      if (def.currentValue != null && def.currentValue !== '') {
        skipped++
        rows.push({
          repo: opts.repo,
          number: issue.number,
          field: def.field,
          old_value: def.currentValue,
          new_value: def.currentValue,
          flagged: false,
        })
        continue
      }

      // No label/title source — nothing to do
      if (!def.legacyToken) {
        continue
      }

      const canonical = def.map[def.legacyToken]

      if (!canonical) {
        flagged.push({
          repo: opts.repo,
          number: issue.number,
          title: issue.title,
          field: def.field,
          observed: def.legacyToken,
        })
        rows.push({
          repo: opts.repo,
          number: issue.number,
          field: def.field,
          old_value: null,
          new_value: null,
          flagged: true,
        })
        continue
      }

      if (!opts.dryRun) {
        await def.apply(canonical)
        updated++
      }

      rows.push({
        repo: opts.repo,
        number: issue.number,
        field: def.field,
        old_value: null,
        new_value: canonical,
        flagged: false,
      })
    }
  }

  // Write snapshot and flagged.txt
  mkdirSync(migrationDir, { recursive: true })

  const ts = formatTimestamp()
  const snapshotFile = opts.snapshotPath ?? join(migrationDir, `backfill-snapshot-${ts}.json`)

  // fix #12: wrap snapshot with kind marker
  const snapshot: BackfillSnapshot = { kind: 'backfill', generatedAt: new Date().toISOString(), rows }
  await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf-8')

  if (flagged.length > 0) {
    // fix #11: timestamped flagged filename
    const flaggedFile = join(migrationDir, `flagged-${ts}.txt`)
    const flaggedLines = flagged.map(
      (f) => `${f.repo}#${f.number} [${f.field}] observed="${f.observed}" title="${f.title}"`,
    )
    await writeFile(flaggedFile, `${flaggedLines.join('\n')}\n`, 'utf-8')
  }

  const dryRunNote = opts.dryRun ? ' (dry-run)' : ''
  console.log(
    `Processed ${issues.length}, updated ${updated}${dryRunNote}, skipped ${skipped}, flagged ${flagged.length}`,
  )
}

// ---------------------------------------------------------------------------
// rewriteTitles
// ---------------------------------------------------------------------------

interface RewriteRow {
  repo: string
  number: number
  old_title: string
  new_title: string
  applied?: boolean
}

export async function rewriteTitles(opts: { repo: string; dryRun: boolean; snapshotPath?: string }): Promise<void> {
  // fix #1: execFileSync instead of execSync (shell injection guard)
  const issuesJson = execFileSync(
    'gh',
    ['issue', 'list', '--repo', opts.repo, '--state', 'open', '--limit', '1000', '--json', 'number,title'],
    { encoding: 'utf-8' },
  )
  const issues = JSON.parse(issuesJson) as Array<{ number: number; title: string }>

  // fix #5: warn when limit ceiling is hit
  if (issues.length >= 1000) {
    console.warn(`Warning: hit --limit 1000 ceiling on repo ${opts.repo}; some issues may be truncated`)
    mkdirSync(migrationDir, { recursive: true })
    const ts = formatTimestamp()
    const flaggedFile = join(migrationDir, `flagged-${ts}.txt`)
    await writeFile(
      flaggedFile,
      `DIAGNOSTIC: hit --limit 1000 ceiling on repo ${opts.repo} at ${new Date().toISOString()} — some issues may be truncated\n`,
      'utf-8',
    )
  }

  const rows: RewriteRow[] = []

  for (const issue of issues) {
    if (!TITLE_PREFIX_RE.test(issue.title)) continue

    const new_title = issue.title.replace(TITLE_PREFIX_RE, '')
    rows.push({ repo: opts.repo, number: issue.number, old_title: issue.title, new_title, applied: false })
  }

  mkdirSync(migrationDir, { recursive: true })

  const ts = formatTimestamp()
  const snapshotFile = opts.snapshotPath ?? join(migrationDir, `rewrite-snapshot-${ts}.json`)

  // fix #6: write snapshot BEFORE live edits (with applied: false on all rows)
  // fix #12: wrap snapshot with kind marker
  const snapshot: RewriteSnapshot = { kind: 'rewrite', generatedAt: new Date().toISOString(), rows }
  await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf-8')

  if (!opts.dryRun) {
    for (const row of rows) {
      // fix #1: execFileSync with argv array (no shell injection)
      execFileSync('gh', ['issue', 'edit', String(row.number), '--repo', opts.repo, '--title', row.new_title], {
        encoding: 'utf-8',
      })
      row.applied = true
    }
    // Rewrite snapshot with applied flags set correctly
    const updatedSnapshot: RewriteSnapshot = { kind: 'rewrite', generatedAt: snapshot.generatedAt, rows }
    await writeFile(snapshotFile, JSON.stringify(updatedSnapshot, null, 2), 'utf-8')
  }

  console.log(`Stripped ${rows.length} titles across repo ${opts.repo}`)
}

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

const FIELD_ID_MAP: Record<string, string> = {
  Lane: LANE_FIELD_ID,
  Size: SIZE_FIELD_ID,
  Priority: PRIORITY_FIELD_ID,
}

interface BackfillRow {
  repo: string
  number: number
  field: string
  old_value: string | null
  new_value: string | null
  flagged: boolean
}

interface RevertError {
  repo: string
  number: number
  field?: string
  error: string
}

// ---------------------------------------------------------------------------
// Row validators (fix #12)
// ---------------------------------------------------------------------------

const VALID_BACKFILL_FIELDS = new Set(['Lane', 'Size', 'Priority', 'issueType'])

function isValidBackfillRow(row: unknown): row is BackfillRow {
  const r = row as Record<string, unknown>
  return (
    typeof r.repo === 'string' &&
    /^[^/]+\/[^/]+$/.test(r.repo) &&
    typeof r.number === 'number' &&
    r.number > 0 &&
    typeof r.field === 'string' &&
    VALID_BACKFILL_FIELDS.has(r.field)
  )
}

function isValidRewriteRow(row: unknown): row is RewriteRow {
  const r = row as Record<string, unknown>
  return (
    typeof r.repo === 'string' &&
    typeof r.number === 'number' &&
    typeof r.old_title === 'string' &&
    typeof r.new_title === 'string'
  )
}

async function fetchIssueFieldState(
  repo: string,
  issueNumber: number,
): Promise<{
  itemId: string
  issueNodeId: string
  currentFields: Record<string, string>
  currentIssueType: string | undefined
}> {
  const [owner, repoName] = repo.split('/')
  const data = (await ghGraphQL(ITEM_FIELDS_QUERY, {
    owner,
    repo: repoName,
    number: issueNumber,
  })) as {
    repository: {
      issue: {
        id: string
        issueType: { id: string; name: string } | null
        projectItems: {
          nodes: Array<{
            id: string
            project: { id: string }
            fieldValues: ProjectItemFieldValues['fieldValues']
          }>
        }
      }
    }
  }

  const issueData = data.repository.issue
  const projectItem = issueData.projectItems.nodes.find((n) => n.project.id === GH_PROJECT_ID)
  if (!projectItem) throw new Error(`Issue #${issueNumber} not found in project`)

  const currentFields: Record<string, string> = {}
  for (const fv of projectItem.fieldValues.nodes) {
    if (fv.name && fv.field?.name) {
      currentFields[fv.field.name] = fv.name
    }
  }

  return {
    itemId: projectItem.id,
    issueNodeId: issueData.id,
    currentFields,
    currentIssueType: issueData.issueType?.name,
  }
}

async function revertBackfillRow(row: BackfillRow): Promise<'reverted' | 'skipped'> {
  if (row.flagged || row.new_value === null) return 'skipped'

  const { itemId, issueNodeId, currentFields, currentIssueType } = await fetchIssueFieldState(row.repo, row.number)

  if (row.field === 'issueType') {
    if (currentIssueType === undefined) {
      console.log(`skip #${row.number}.issueType`)
      return 'skipped'
    }
    // FIXME(#121): revert with null issueTypeId is unverified — schema allows it but API behaviour unconfirmed.
    // Manual verification needed before production revert.
    await updateIssueIssueType(issueNodeId, null)
    return 'reverted'
  }

  const fieldId = FIELD_ID_MAP[row.field]
  if (!fieldId) throw new Error(`Unknown field: ${row.field}`)

  if (currentFields[row.field] === undefined) {
    console.log(`skip #${row.number}.${row.field}`)
    return 'skipped'
  }

  await clearField(itemId, fieldId)
  return 'reverted'
}

async function revertRewriteRow(row: RewriteRow): Promise<'reverted' | 'skipped'> {
  const currentTitleRaw = await run([
    'gh',
    'issue',
    'view',
    String(row.number),
    '--repo',
    row.repo,
    '--json',
    'title',
    '--jq',
    '.title',
  ])
  // fix #8: trim output before comparison (trailing newline defeats idempotency)
  const currentTitle = currentTitleRaw.trim()

  if (currentTitle === row.old_title) {
    console.log(`skip #${row.number}`)
    return 'skipped'
  }

  await run(['gh', 'issue', 'edit', String(row.number), '--repo', row.repo, '--title', row.old_title])
  return 'reverted'
}

export async function revert(opts: { snapshotPath: string }): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const raw = await readFile(opts.snapshotPath, 'utf-8')
  const parsed = JSON.parse(raw) as unknown

  // fix #12: detect kind marker; fall back to duck-typing for backwards compat
  let isBackfill: boolean
  let isRewrite: boolean
  let rawRows: unknown[]

  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'kind' in (parsed as Record<string, unknown>)
  ) {
    const envelope = parsed as { kind: string; rows: unknown[] }
    rawRows = Array.isArray(envelope.rows) ? envelope.rows : []
    isBackfill = envelope.kind === 'backfill'
    isRewrite = envelope.kind === 'rewrite'
  } else {
    // Backwards compat: legacy plain array snapshots
    if (!Array.isArray(parsed)) {
      console.error('Snapshot is not an array or envelope object')
      process.exit(1)
      return
    }
    rawRows = parsed as unknown[]
    const first = rawRows[0] as Record<string, unknown> | undefined
    isBackfill = first != null && 'field' in first && 'old_value' in first && 'new_value' in first && 'flagged' in first
    isRewrite = first != null && 'old_title' in first && 'new_title' in first && !('field' in first)
  }

  // fix #7: empty array → log + return (not exit 1)
  if (rawRows.length === 0) {
    console.log('Snapshot is empty — nothing to revert')
    return
  }

  if (!isBackfill && !isRewrite) {
    console.error('Unknown snapshot format')
    process.exit(1)
  }

  let reverted = 0
  let skipped = 0
  const errors: RevertError[] = []

  if (isBackfill) {
    for (const row of rawRows) {
      // fix #12: per-row validation
      if (!isValidBackfillRow(row)) {
        console.log(`skip invalid backfill row: ${JSON.stringify(row)}`)
        continue
      }
      try {
        const outcome = await revertBackfillRow(row)
        if (outcome === 'reverted') reverted++
        else skipped++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ repo: row.repo, number: row.number, field: row.field, error: message })
        console.error(`error #${row.number}.${row.field}: ${message}`)
      }
    }
  } else {
    for (const row of rawRows) {
      // fix #12: per-row validation
      if (!isValidRewriteRow(row)) {
        console.log(`skip invalid rewrite row: ${JSON.stringify(row)}`)
        continue
      }
      try {
        const outcome = await revertRewriteRow(row)
        if (outcome === 'reverted') reverted++
        else skipped++
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ repo: row.repo, number: row.number, error: message })
        console.error(`error #${row.number}: ${message}`)
      }
    }
  }

  console.log(`Reverted ${reverted} rows, skipped ${skipped} already-reverted, errors ${errors.length}`)
  if (errors.length > 0) {
    for (const e of errors) {
      const loc = e.field ? `${e.repo}#${e.number} [${e.field}]` : `${e.repo}#${e.number}`
      console.error(`  ${loc}: ${e.error}`)
    }
  }
}
