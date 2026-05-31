/**
 * migrate-revert.ts — revert subcommand for taxonomy migration.
 */

import { GH_PROJECT_ID, LANE_FIELD_ID, PRIORITY_FIELD_ID, SIZE_FIELD_ID } from '../../shared/adapters/config-helpers'
import { clearField, ghGraphQL, run, updateIssueIssueType } from '../../shared/adapters/github-adapter'
import {
  type BackfillRow,
  ITEM_FIELDS_QUERY,
  type ProjectItemFieldValues,
  type RevertError,
  type RewriteRow,
} from './migrate-shared'

// ---------------------------------------------------------------------------
// FIELD_ID_MAP
// ---------------------------------------------------------------------------

export const FIELD_ID_MAP: Record<string, string> = {
  Lane: LANE_FIELD_ID,
  Size: SIZE_FIELD_ID,
  Priority: PRIORITY_FIELD_ID,
}

// ---------------------------------------------------------------------------
// Row validators (fix #12)
// ---------------------------------------------------------------------------

const VALID_BACKFILL_FIELDS = new Set(['Lane', 'Size', 'Priority', 'issueType'])

export function isValidBackfillRow(row: unknown): row is BackfillRow {
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

export function isValidRewriteRow(row: unknown): row is RewriteRow {
  const r = row as Record<string, unknown>
  return (
    typeof r.repo === 'string' &&
    typeof r.number === 'number' &&
    typeof r.old_title === 'string' &&
    typeof r.new_title === 'string'
  )
}

// ---------------------------------------------------------------------------
// fetchIssueFieldState
// ---------------------------------------------------------------------------

export async function fetchIssueFieldState(
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

// ---------------------------------------------------------------------------
// revertBackfillRow
// ---------------------------------------------------------------------------

export async function revertBackfillRow(row: BackfillRow, allowIssueType = true): Promise<'reverted' | 'skipped'> {
  if (row.flagged || row.new_value === null) return 'skipped'

  if (row.field === 'issueType' && !allowIssueType) {
    return 'skipped'
  }

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

// ---------------------------------------------------------------------------
// revertRewriteRow
// ---------------------------------------------------------------------------

export async function revertRewriteRow(row: RewriteRow): Promise<'reverted' | 'skipped'> {
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

// ---------------------------------------------------------------------------
// revert
// ---------------------------------------------------------------------------

export async function revert(opts: { snapshotPath: string; yes?: boolean }): Promise<void> {
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

  // Confirmation gate for issueType null-reverts (FIXME #121: unverified API operation)
  let allowIssueType = true
  if (isBackfill) {
    const issueTypeRows = rawRows
      .filter(isValidBackfillRow)
      .filter((r) => r.field === 'issueType' && !r.flagged && r.new_value !== null)
    if (issueTypeRows.length > 0) {
      const affected = issueTypeRows.map((r) => `#${r.number}`).join(', ')
      process.stderr.write(
        `\nWARNING: ${issueTypeRows.length} row(s) would call updateIssueIssueType(node, null) — ` +
          `this operation is unverified (FIXME #121). Affected: ${affected}\n\n`,
      )
      if (opts.yes) {
        allowIssueType = true
      } else if (process.stdin.isTTY) {
        const { createInterface } = await import('node:readline')
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question('Proceed with issueType reverts? [y/N] ', (ans) => {
            rl.close()
            resolve(ans)
          })
        })
        allowIssueType = answer === 'y' || answer === 'Y'
      } else {
        // Non-interactive: skip issueType reverts
        allowIssueType = false
      }
    }
  }

  if (isBackfill) {
    let issueTypeSkipped = 0
    for (const row of rawRows) {
      // fix #12: per-row validation
      if (!isValidBackfillRow(row)) {
        console.log(`skip invalid backfill row: ${JSON.stringify(row)}`)
        continue
      }
      try {
        const outcome = await revertBackfillRow(row, allowIssueType)
        if (outcome === 'reverted') reverted++
        else {
          skipped++
          if (row.field === 'issueType' && !allowIssueType && !row.flagged && row.new_value !== null) {
            issueTypeSkipped++
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ repo: row.repo, number: row.number, field: row.field, error: message })
        console.error(`error #${row.number}.${row.field}: ${message}`)
      }
    }

    console.log(`Reverted ${reverted} rows, skipped ${skipped} already-reverted, errors ${errors.length}`)
    if (errors.length > 0) {
      for (const e of errors) {
        const loc = e.field ? `${e.repo}#${e.number} [${e.field}]` : `${e.repo}#${e.number}`
        console.error(`  ${loc}: ${e.error}`)
      }
    }
    if (issueTypeSkipped > 0) {
      console.log(`Skipped ${issueTypeSkipped} issueType revert(s) — confirmation not given`)
      process.exitCode = 1
    }
    return
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
