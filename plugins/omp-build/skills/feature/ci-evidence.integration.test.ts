/**
 * Native CI evidence through the simulated GraphQL rollup.
 * The reader pages at 100. The failure identities exist only on the second page.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { failedCheckEvidenceDigest, type Scope } from '../../engine/schemas.ts'
import { readNativeCiFailureEvidence } from '../../roxabi/workflow.ts'

const SIM = join(import.meta.dirname, 'gh-simulator.ts')
const SHA = 'c'.repeat(40)
const SCOPE: Scope = { repository: 'acme/app', target: 'acme/app#7' }
const CHECK_ID = 'CR_publish_page2'
const STATUS_ID = 'SC_lint_page2'
const PAGE = 100

type Check = {
  name: string
  status: string
  conclusion: string
  workflowName: string
  startedAt: string
  id?: string
  kind?: 'check-run' | 'status-context'
  context?: string
  state?: string
}

function state(checks: Check[], ciPageInfo?: 'absent'): string {
  const root = mkdtempSync(join(tmpdir(), 'omp-ci-evidence-'))
  const file = join(root, 'gh-state.json')
  writeFileSync(
    file,
    JSON.stringify({
      viewer: 'operator',
      owner: 'acme',
      name: 'app',
      defaultBranch: 'main',
      origin: '',
      requiredChecks: [],
      nextPr: 1,
      clock: 0,
      issues: {},
      prs: {},
      checks: { [SHA]: checks },
      events: {},
      calls: [],
      ...(ciPageInfo === undefined ? {} : { ciPageInfo }),
    }),
  )
  return file
}

function green(index: number): Check {
  return {
    id: `CR_green_${index}`,
    name: `gate-${index}`,
    status: 'completed',
    conclusion: 'success',
    workflowName: 'ci',
    startedAt: '2026-01-01T00:00:00Z',
  }
}

function ghOf(file: string, pages: unknown[]): (cwd: string, args: string[]) => Promise<string> {
  return async (_cwd, args) => {
    const stdout = execFileSync('bun', [SIM, ...args], {
      env: { ...process.env, GH_SIM_STATE: file },
      encoding: 'utf8',
    })
    pages.push(JSON.parse(stdout))
    return stdout
  }
}

function nodesOf(page: unknown): unknown[] {
  if (page === null || typeof page !== 'object') return []
  const data = (
    page as { data?: { repository?: { object?: { statusCheckRollup?: { contexts?: { nodes?: unknown[] } } } } } }
  ).data
  return data?.repository?.object?.statusCheckRollup?.contexts?.nodes ?? []
}

describe('native CI evidence', () => {
  it('admits only the second-page failure identities', async () => {
    const checks = [
      ...Array.from({ length: PAGE }, (_, index) => green(index)),
      {
        id: CHECK_ID,
        name: 'publish',
        status: 'completed',
        conclusion: 'failure',
        workflowName: 'ci',
        startedAt: '2026-01-01T00:01:00Z',
      },
      {
        id: STATUS_ID,
        kind: 'status-context' as const,
        name: 'lint',
        context: 'lint',
        state: 'failure',
        status: 'completed',
        conclusion: 'failure',
        workflowName: 'ci',
        startedAt: '2026-01-01T00:02:00Z',
      },
    ]
    const file = state(checks)
    const pages: unknown[] = []
    const read = await readNativeCiFailureEvidence('/tmp', SCOPE.repository, SHA, SCOPE, {
      gh: ghOf(file, pages),
      failedCheckEvidenceDigest,
    })
    const failures = [
      { name: 'publish', source: 'github-check-run', observationId: CHECK_ID, conclusion: 'failure' },
      { name: 'lint', source: 'github-status-context', observationId: STATUS_ID, conclusion: 'failure' },
    ]
    expect(read).toMatchObject({ ok: true, failedChecks: ['publish', 'lint'], failures })
    if (!read.ok) return
    expect(read.evidenceDigest).toBe(failedCheckEvidenceDigest({ candidateGitSHA: SHA, scope: SCOPE, failures }))
    expect(pages).toHaveLength(2)
    expect(nodesOf(pages[0]).map((node) => (node as { id?: string }).id)).not.toContain(CHECK_ID)
    expect(nodesOf(pages[0]).map((node) => (node as { id?: string }).id)).not.toContain(STATUS_ID)
    expect(nodesOf(pages[1])).toEqual([
      expect.objectContaining({ __typename: 'CheckRun', id: CHECK_ID, name: 'publish', conclusion: 'failure' }),
      expect.objectContaining({ __typename: 'StatusContext', id: STATUS_ID, context: 'lint', state: 'failure' }),
    ])
    const calls = JSON.parse(readFileSync(file, 'utf8')).calls as string[][]
    expect(calls[1]).toContain('after=sim-ci:100')
  })

  it('refuses a rollup whose pageInfo is missing', async () => {
    const file = state(
      [
        {
          id: CHECK_ID,
          name: 'publish',
          status: 'completed',
          conclusion: 'failure',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:01:00Z',
        },
      ],
      'absent',
    )
    const pages: unknown[] = []
    const read = await readNativeCiFailureEvidence('/tmp', SCOPE.repository, SHA, SCOPE, {
      gh: ghOf(file, pages),
      failedCheckEvidenceDigest,
    })
    expect(read).toEqual({ ok: false, reason: 'ci-evidence-incomplete' })
    expect(nodesOf(pages[0])).toEqual([
      expect.objectContaining({ __typename: 'CheckRun', id: CHECK_ID, name: 'publish', conclusion: 'failure' }),
    ])
    expect(JSON.stringify(pages[0])).not.toContain('pageInfo')
  })
})
