/**
 * migrate.ts — taxonomy migration subcommands: audit-schema, backfill, rewrite-titles, revert.
 * See artifacts/specs/121-dual-write-migration-spec.mdx.
 */

import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { ghGraphQL, resolveIssueTypeId, updateField, updateIssueIssueType } from '../../shared/adapters/github-adapter'

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
  const data = (await ghGraphQL(PROJECT_FIELDS_QUERY, { projectId: GH_PROJECT_ID })) as {
    node: {
      fields: {
        nodes: Array<Partial<FieldSchema>>
      }
    }
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

  // List open issues
  const issuesJson = execSync(
    `gh issue list --repo ${opts.repo} --state open --limit 1000 --json number,title,labels,id`,
    { encoding: 'utf-8' },
  )
  const issues = JSON.parse(issuesJson) as GhIssueListItem[]

  const rows: Row[] = []
  const flagged: FlaggedEntry[] = []
  let updated = 0
  let skipped = 0

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
        apply: async (canonical) => {
          const org = opts.repo.split('/')[0]
          const typeId = await resolveIssueTypeId(org, canonical)
          await updateIssueIssueType(issueNodeId, typeId)
        },
      },
    ]

    for (const def of fieldDefs) {
      // Already set — skip (idempotent)
      if (def.currentValue) {
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
  const migrationDir = 'artifacts/migration'
  mkdirSync(migrationDir, { recursive: true })

  const snapshotFile = opts.snapshotPath ?? join(migrationDir, `backfill-snapshot-${formatTimestamp()}.json`)
  await writeFile(snapshotFile, JSON.stringify(rows, null, 2), 'utf-8')

  if (flagged.length > 0) {
    const flaggedFile = join(migrationDir, 'flagged.txt')
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
}

export async function rewriteTitles(opts: { repo: string; dryRun: boolean; snapshotPath?: string }): Promise<void> {
  const issuesJson = execSync(`gh issue list --repo ${opts.repo} --state open --limit 1000 --json number,title`, {
    encoding: 'utf-8',
  })
  const issues = JSON.parse(issuesJson) as Array<{ number: number; title: string }>

  const rows: RewriteRow[] = []

  for (const issue of issues) {
    if (!TITLE_PREFIX_RE.test(issue.title)) continue

    const new_title = issue.title.replace(TITLE_PREFIX_RE, '')
    rows.push({ repo: opts.repo, number: issue.number, old_title: issue.title, new_title })
  }

  if (!opts.dryRun) {
    for (const row of rows) {
      execSync(`gh issue edit ${row.number} --repo ${opts.repo} --title ${JSON.stringify(row.new_title)}`, {
        encoding: 'utf-8',
      })
    }
  }

  const migrationDir = 'artifacts/migration'
  mkdirSync(migrationDir, { recursive: true })

  const snapshotFile = opts.snapshotPath ?? join(migrationDir, `rewrite-snapshot-${formatTimestamp()}.json`)
  await writeFile(snapshotFile, JSON.stringify(rows, null, 2), 'utf-8')

  console.log(`Stripped ${rows.length} titles across repo ${opts.repo}`)
}
