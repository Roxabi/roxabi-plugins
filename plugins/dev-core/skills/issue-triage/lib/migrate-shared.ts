/**
 * migrate-shared.ts — shared constants, types, and utilities for migrate subcommands.
 */

import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Repo-root-anchored migrationDir (fix #3: CWD-relative → anchor to repo root)
// ---------------------------------------------------------------------------

const __dir = path.dirname(fileURLToPath(import.meta.url))
// migrate-shared.ts lives at plugins/dev-core/skills/issue-triage/lib — repo root is 5 levels up
export const REPO_ROOT = path.resolve(__dir, '..', '..', '..', '..', '..', '..')
export const migrationDir = path.join(REPO_ROOT, 'artifacts', 'migration')

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

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

export function formatTimestamp(): string {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const min = String(now.getMinutes()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${min}`
}

// ---------------------------------------------------------------------------
// Shared GraphQL query
// ---------------------------------------------------------------------------

export const ITEM_FIELDS_QUERY = `
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

// ---------------------------------------------------------------------------
// Cross-boundary types
// ---------------------------------------------------------------------------

export interface BackfillRow {
  repo: string
  number: number
  field: string
  old_value: string | null
  new_value: string | null
  flagged: boolean
}

export interface RewriteRow {
  repo: string
  number: number
  old_title: string
  new_title: string
  applied?: boolean
}

export interface ProjectItemFieldValues {
  fieldValues: {
    nodes: Array<{
      name?: string
      field?: { name?: string }
    }>
  }
}

export interface BackfillSnapshot {
  kind: 'backfill'
  generatedAt: string
  rows: BackfillRow[]
}

export interface RewriteSnapshot {
  kind: 'rewrite'
  generatedAt: string
  rows: RewriteRow[]
}

export interface RevertError {
  repo: string
  number: number
  field?: string
  error: string
}
