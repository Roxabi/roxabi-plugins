/**
 * migrate-backfill.ts — backfill and rewrite-titles subcommands for taxonomy migration.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_LANE_OPTIONS,
  GH_PROJECT_ID,
  LANE_FIELD_ID,
  LANE_OPTIONS,
  PRIORITY_ALIASES,
  PRIORITY_FIELD_ID,
  PRIORITY_OPTIONS,
  SIZE_FIELD_ID,
  SIZE_OPTIONS,
} from '../../shared/adapters/config-helpers'
import { ghGraphQL, listOrgIssueTypes, updateField, updateIssueIssueType } from '../../shared/adapters/github-adapter'
import { ISSUE_TYPE_NAMES } from '../../shared/domain/issue-types'
import { auditSchema } from './migrate-audit'
import {
  type BackfillRow,
  type BackfillSnapshot,
  formatTimestamp,
  ITEM_FIELDS_QUERY,
  migrationDir,
  type ProjectItemFieldValues,
  type RewriteRow,
  type RewriteSnapshot,
} from './migrate-shared'

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
  priority: PRIORITY_ALIASES,
  issueType: Object.fromEntries(ISSUE_TYPE_NAMES.map((t) => [t, t])) as Record<string, string>,
}

// ---------------------------------------------------------------------------
// TITLE_PREFIX_RE — extract conventional-commit type from issue title
// ---------------------------------------------------------------------------

export const TITLE_PREFIX_RE = /^(feat|fix|refactor|docs|test|chore|ci|perf)(\(.+?\))?:\s*/

// ---------------------------------------------------------------------------
// Backfill types
// ---------------------------------------------------------------------------

export interface GhIssueListItem {
  number: number
  title: string
  labels: Array<{ name: string }>
  id: string
}

export interface FlaggedEntry {
  repo: string
  number: number
  title: string
  field: string
  observed: string
}

export interface LegacyValues {
  lane?: string
  size?: string
  priority?: string
  issueType?: string
}

// ---------------------------------------------------------------------------
// extractLegacyValues
// ---------------------------------------------------------------------------

export function extractLegacyValues(issue: GhIssueListItem): LegacyValues {
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

  const rows: BackfillRow[] = []
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
