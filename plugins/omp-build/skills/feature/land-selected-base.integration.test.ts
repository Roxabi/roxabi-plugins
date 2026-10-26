import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim, SIM, sandbox, WORKFLOW, worktree, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PR = 30
const BRANCH = 'fix/5-plain'
const NEXT = 'fix/5-next'
const ISSUE = 5
const BODY = 'Closes #5\n'
const { encodedAdmissionReviewGraph } = roxabiRecordFixtures()
const { linkedLandingAuthority } = roxabiWorkflowFixtures()

let roots: string[] = []
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function createBox(mode = 'native'): { box: Box; cwd: string } {
  const box = sandbox({
    base: {
      '.dev/stack.yml': `landing:\n  mode: ${mode}\n  required_checks:\n    - ci\n`,
      'src/a.ts': 'export const add = (a: number, b: number) => a + b\n',
    },
    branches: [
      {
        name: BRANCH,
        from: 'main',
        commits: [{ message: 'fix: plain (#5)', files: { 'src/a.ts': 'export const plain = true\n' } }],
      },
      {
        name: NEXT,
        from: BRANCH,
        commits: [{ message: 'fix: next (#5)', files: { 'src/next.ts': 'export const next = true\n' } }],
      },
      {
        name: 'staging',
        from: 'main',
        commits: [{ message: 'chore: staging', files: { 'src/staging.ts': 'export const staging = true\n' } }],
      },
    ],
    issues: [{ number: ISSUE, title: 'fix: plain', issueType: 'fix' }],
    prs: [{ number: PR, branch: BRANCH, title: 'fix: plain', body: BODY, closes: [ISSUE] }],
  })
  roots.push(box.root)
  return { box, cwd: worktree(box, 'landing', box.sha[BRANCH] as string) }
}

function captureInput(box: Box, cwd: string, head: string): string {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: PR, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`captureReviewInput failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as { ok: boolean; input?: string | null }
  if (!captured.ok || captured.input === null || captured.input === undefined)
    throw new Error('review input unavailable')
  return captured.input
}

function prepare(box: Box, cwd: string, armed = false): void {
  const head = box.sha[BRANCH] as string
  const authority = linkedLandingAuthority({
    repository: 'acme/app',
    issueNumber: ISSUE,
    prNumber: PR,
    branch: BRANCH,
    base: 'main',
    issueBody: '## Acceptance criteria\n\n- [ ] lands\n',
    lineageHead: head,
    author: 'operator',
  })
  writeSim(box, (state) => {
    const pull = state.prs[String(PR)]
    const issue = state.issues[String(ISSUE)]
    if (!pull || !issue) throw new Error('landing fixture scope missing')
    issue.comments = authority.issueBodies.map((body) => ({ author: 'operator', body }))
    pull.comments = authority.bindingBodies.map((body) => ({ author: 'operator', body }))
    pull.labels = armed ? ['reviewed'] : []
    pull.autoMerge = armed ? { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: head } : null
    pull.baseRefName = 'main'
    pull.headRefName = BRANCH
    pull.headRefOid = head
    pull.state = 'OPEN'
    pull.mergeCommit = null
    pull.mergedAt = null
  })
  const input = captureInput(box, cwd, head)
  const review = encodedAdmissionReviewGraph({
    scope: { repository: 'acme/app', target: `acme/app#${PR}` },
    head,
    input,
    verdict: 'Approve (clean)',
    prefix: 'selected-base',
  })
  writeSim(box, (state) => {
    const pull = state.prs[String(PR)]
    if (!pull) throw new Error('missing pull')
    pull.comments.push(...review.comments.map(({ body }) => ({ author: 'operator', body })))
  })
}

function land(box: Box, cwd: string, mode: 'native' | 'merge-on-green') {
  const before = readSim(box).calls.length
  const run = spawnSync(
    BUN,
    [WORKFLOW, 'landPr', cwd, JSON.stringify({ pr: PR, landing: { mode, required_checks: ['ci'] } })],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
    },
  )
  if (run.status !== 0) throw new Error(`landPr failed: ${run.stderr}\n${run.stdout}`)
  const state = readSim(box)
  const pull = state.prs[String(PR)]
  if (!pull) throw new Error('missing pull after land')
  return {
    result: JSON.parse(run.stdout) as { status: string; reason?: string; error?: string },
    pull,
    calls: state.calls.slice(before),
  }
}

function green(box: Box, head = box.sha[BRANCH] as string): void {
  writeSim(box, (state) => {
    state.checks[head] = [
      { name: 'ci', status: 'completed', conclusion: 'success', workflowName: 'ci', startedAt: '2026-01-01T00:00:00Z' },
    ]
  })
}

function mutateAfter(box: Box, when: 'label' | 'pin' | 'admission-comments', change: string): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-selected-base-'))
  const shim = path.join(dir, 'gh')
  const originalPath = box.env.PATH
  writeFileSync(
    shim,
    `#!${BUN}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const comments = args.some((arg) => arg.includes('/comments?') || arg.endsWith('/comments'))
const countFile = ${JSON.stringify(path.join(dir, 'comment-reads'))}
const count = comments ? (existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0) + 1 : 0
if (comments) writeFileSync(countFile, String(count))
const output = spawnSync(${JSON.stringify(BUN)}, [${JSON.stringify(SIM)}, ...args], { env: process.env, encoding: 'utf8' })
const marker = ${JSON.stringify(path.join(dir, 'mutated'))}
const match = ${JSON.stringify(when)} === 'label'
  ? args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')
  : ${JSON.stringify(when)} === 'pin'
    ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')
    : comments && count === 2
if (output.status === 0 && match && !existsSync(marker)) {
  const state = JSON.parse(readFileSync(process.env.GH_SIM_STATE, 'utf8'))
  ${change}
  writeFileSync(process.env.GH_SIM_STATE, JSON.stringify(state))
  writeFileSync(marker, 'done')
}
process.stdout.write(output.stdout)
process.stderr.write(output.stderr)
process.exit(output.status ?? 1)
`,
  )
  chmodSync(shim, 0o755)
  box.env.PATH = `${dir}:${originalPath}`
  return () => {
    box.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('landPr retains the selected base name and tip', () => {
  it.each(['native', 'merge-on-green'] as const)('%s keeps watching when nothing moves', (mode) => {
    const { box, cwd } = createBox(mode)
    prepare(box, cwd)

    const run = land(box, cwd, mode)

    expect(run.result).toMatchObject({ status: 'watching', mode })
    expect(run.pull.labels).toEqual(['reviewed'])
    expect(run.pull.autoMerge).toEqual(
      mode === 'native' ? expect.objectContaining({ matchHeadCommit: box.sha[BRANCH] }) : null,
    )
  })

  it.each(['native', 'merge-on-green'] as const)('%s lands a green PR onto the selected tip', (mode) => {
    const { box, cwd } = createBox(mode)
    prepare(box, cwd)
    green(box)

    const run = land(box, cwd, mode)

    expect(run.result.status).toBe(mode === 'native' ? 'merged' : 'watching')
    expect(run.pull.state).toBe('MERGED')
    expect(run.pull.mergeCommit?.parents).toEqual([box.sha.main, box.sha[BRANCH]])
  })

  it('reports merged when native auto-merge completes during post-write observation', () => {
    const { box, cwd } = createBox()
    prepare(box, cwd)
    green(box)

    const run = land(box, cwd, 'native')

    expect(run.result).toEqual({ status: 'merged' })
    expect(run.pull.state).toBe('MERGED')
    expect(run.calls.some((args) => args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label'))).toBe(false)
    expect(run.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto'))).toHaveLength(
      1,
    )
  })

  it('refuses native landing once it merged onto a base moved after selection', () => {
    const { box, cwd } = createBox()
    prepare(box, cwd)
    green(box)
    const restore = mutateAfter(
      box,
      'pin',
      `const moved = spawnSync('git', ['--git-dir', ${JSON.stringify(box.origin)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.staging)}], { encoding: 'utf8' }); if (moved.status !== 0) throw new Error(moved.stderr)`,
    )
    try {
      const run = land(box, cwd, 'native')
      expect(run.result.status).toBe('auto-merge-failed')
      expect(run.pull.mergeCommit?.parents).toEqual([box.sha.staging, box.sha[BRANCH]])
    } finally {
      restore()
    }
  })

  it('refuses a merge-on-green wrong-head merge instead of claiming watching or merged', () => {
    const { box, cwd } = createBox('merge-on-green')
    prepare(box, cwd)
    green(box)
    const h2 = box.sha[NEXT] as string
    green(box, h2)
    const restore = mutateAfter(
      box,
      'label',
      `state.prs[${PR}].headRefOid = ${JSON.stringify(h2)}; state.prs[${PR}].headRefName = ${JSON.stringify(NEXT)}`,
    )
    try {
      const run = land(box, cwd, 'merge-on-green')
      expect(run.result).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
    } finally {
      restore()
    }
  })

  it('does not claim merged or watching when a native post-admit race changes the head', () => {
    const { box, cwd } = createBox()
    prepare(box, cwd)
    green(box)
    const h2 = box.sha[NEXT] as string
    green(box, h2)
    const restore = mutateAfter(
      box,
      'pin',
      `state.prs[${PR}].headRefOid = ${JSON.stringify(h2)}; state.prs[${PR}].headRefName = ${JSON.stringify(NEXT)}; if (state.prs[${PR}].autoMerge) state.prs[${PR}].autoMerge.matchHeadCommit = ${JSON.stringify(h2)}`,
    )
    try {
      const run = land(box, cwd, 'native')
      expect(run.result).toMatchObject({ status: 'auto-merge-failed' })
    } finally {
      restore()
    }
  })

  it('does not claim merged or watching when admission never succeeds and a prior arm settles onto the tip', () => {
    const { box, cwd } = createBox()
    prepare(box, cwd, true)
    green(box)
    const restore = mutateAfter(box, 'admission-comments', `state.prs[${PR}].baseRefName = 'staging'`)
    try {
      let result: { status: string } | undefined
      let thrown: unknown
      try {
        result = land(box, cwd, 'native').result
      } catch (error) {
        thrown = error
      }
      if (result !== undefined) {
        expect(result).toMatchObject({ status: 'review-input-refused', reason: 'unbound' })
      } else {
        expect(String(thrown)).toMatch(/merged while being disarmed|landPr failed/)
        expect(String(thrown)).not.toMatch(/"status":"watching"|"status":"merged"/)
      }
    } finally {
      restore()
    }
  })

  it.each(['native', 'merge-on-green'] as const)('%s refuses an unreadable selected base tip', (mode) => {
    const { box, cwd } = createBox(mode)
    prepare(box, cwd)
    const restore = mutateAfter(box, 'label', `state.prs[${PR}].baseRefName = 'missing'`)
    try {
      const run = land(box, cwd, mode)
      expect(run.result).toMatchObject({ status: 'base-blocked', reason: 'unreadable' })
      expect(run.pull.labels).toEqual([])
      expect(run.pull.autoMerge).toBeNull()
    } finally {
      restore()
    }
  })
})

describe('origin identity is bound to the selected repository before base policy', () => {
  it.each(['native', 'merge-on-green'] as const)('%s refuses a fork origin before it reads the base policy', (mode) => {
    const { box, cwd } = createBox(mode)
    prepare(box, cwd)
    const fork = path.join(box.root, 'fork.git')
    git(box, box.root, ['clone', '-q', '--bare', box.origin, fork])
    writeSim(box, (state) => {
      state.repositoryUrls = { [fork]: 'fork/app' }
    })
    git(box, cwd, ['remote', 'set-url', 'origin', fork])

    const run = land(box, cwd, mode)

    expect(run.result).toMatchObject({ status: 'base-blocked', reason: 'unbound' })
    expect(run.pull.labels).toEqual([])
    expect(run.pull.autoMerge).toBeNull()
    expect(run.calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
  })
})
