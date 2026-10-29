import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export function createConcurrentPausePull(cwd: string): number {
  const head = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim()
  if (head.length === 0) throw new Error('pause branch unavailable')
  const raw = execFileSync(
    'gh',
    [
      'api',
      'repos/acme/app/pulls',
      '--method',
      'POST',
      '-f',
      `head=${head}`,
      '-f',
      'base=main',
      '-f',
      'title=concurrent pause disarm fixture',
    ],
    { cwd, encoding: 'utf8' },
  )
  const created: unknown = JSON.parse(raw)
  if (
    created === null ||
    typeof created !== 'object' ||
    !('number' in created) ||
    typeof created.number !== 'number' ||
    !Number.isSafeInteger(created.number)
  ) {
    throw new Error('pause pull creation unreadable')
  }
  return created.number
}

export function makePauseDisarmUnreadable(pr: number): void {
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('pause simulator state unavailable')
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { prs?: Record<string, { labels?: unknown }> }
  const pull = state.prs?.[String(pr)]
  if (pull === undefined) throw new Error('pause disarm pull request unavailable')
  pull.labels = [1]
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
}
