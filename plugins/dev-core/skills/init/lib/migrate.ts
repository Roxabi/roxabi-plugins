/**
 * Migrate open issues onto a GitHub Project V2 board.
 * Fetches repo issues, diffs against board items, adds missing ones.
 */

import { run, getBoardIssueNumbers } from '../../shared/github'

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
  const onBoardNumbers = await getBoardIssueNumbers(owner, projectNumber)

  // 3. Diff: find issues not yet on the board
  const missing = issues.filter((i) => !onBoardNumbers.has(i.number))
  result.alreadyOnBoard = result.total - missing.length

  // 4. Add missing issues to the project in batches
  const BATCH_SIZE = 10
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE)
    const results = await Promise.allSettled(
      batch.map((issue) =>
        run([
          'gh', 'project', 'item-add', String(projectNumber),
          '--owner', owner,
          '--url', issue.url,
        ]).then(() => issue.number)
      )
    )
    for (let j = 0; j < results.length; j++) {
      const r = results[j]
      if (r.status === 'fulfilled') {
        result.added++
      } else {
        result.failed++
        result.errors.push(`#${batch[j].number}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
      }
    }
  }

  return result
}
