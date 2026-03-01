/**
 * Migrate open issues onto a GitHub Project V2 board.
 * Fetches repo issues, diffs against board items, adds missing ones.
 */

import { run } from '../../shared/github'

export interface MigrateResult {
  total: number
  alreadyOnBoard: number
  added: number
  failed: number
  errors: string[]
}

export async function migrateIssues(
  owner: string,
  repo: string,
  projectNumber: number
): Promise<MigrateResult> {
  const result: MigrateResult = { total: 0, alreadyOnBoard: 0, added: 0, failed: 0, errors: [] }

  // 1. Fetch all open issues from the repo
  const issuesJson = await run([
    'gh', 'issue', 'list',
    '--repo', `${owner}/${repo}`,
    '--state', 'open',
    '--json', 'number,url',
    '--limit', '500',
  ])
  const issues = JSON.parse(issuesJson) as Array<{ number: number; url: string }>
  result.total = issues.length

  if (issues.length === 0) return result

  // 2. Fetch all items currently on the project board
  const itemsJson = await run([
    'gh', 'project', 'item-list', String(projectNumber),
    '--owner', owner,
    '--format', 'json',
    '--limit', '500',
  ])
  const itemsData = JSON.parse(itemsJson) as { items: Array<{ content: { number: number; type: string } }> }
  const onBoardNumbers = new Set(
    (itemsData.items ?? [])
      .filter((i) => i.content?.type === 'Issue')
      .map((i) => i.content.number)
  )

  // 3. Diff: find issues not yet on the board
  const missing = issues.filter((i) => !onBoardNumbers.has(i.number))
  result.alreadyOnBoard = result.total - missing.length

  // 4. Add each missing issue to the project
  for (const issue of missing) {
    try {
      await run([
        'gh', 'project', 'item-add', String(projectNumber),
        '--owner', owner,
        '--url', issue.url,
      ])
      result.added++
    } catch (err) {
      result.failed++
      result.errors.push(`#${issue.number}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
