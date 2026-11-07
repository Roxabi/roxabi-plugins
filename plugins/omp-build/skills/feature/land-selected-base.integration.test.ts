import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { criterionPullHistory, criterionReviewGraph } from '../../testing/criterion-approval.ts'
import { graphFromSimulatedIssues } from '../../testing/criterion-dispositions.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { nativeImplementationWorld } from '../../testing/native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim, sandbox, WORKFLOW, worktree, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'
import { eligiblePlan } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PR = 30
const BRANCH = 'fix/5-plain'
const NEXT = 'fix/5-next'
const ISSUE = 5
const ISSUE_SCOPE = { repository: 'acme/app', target: `acme/app#${ISSUE}` }
const LANDING_SPEC = nativeFeatureSpec(ISSUE_SCOPE, 'lands')
const BODY = 'Closes #5\n'
const { projection } = roxabiRecordFixtures()
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
    issues: [{ number: ISSUE, title: 'fix: plain', issueType: 'fix', labels: ['size:S'] }],
    prs: [{ number: PR, branch: BRANCH, title: 'fix: plain', body: BODY, closes: [ISSUE] }],
  })
  roots.push(box.root)
  return { box, cwd: worktree(box, 'landing', box.sha[BRANCH] as string) }
}

function captureInput(box: Box, cwd: string, head: string): { input: string; inputs: ActionInputs } {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: PR, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`captureReviewInput failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as {
    ok: boolean
    input?: string | null
    inputs?: ActionInputs
    reason?: string
    error?: string
  }
  const inputs = captured.inputs
  if (
    !captured.ok ||
    typeof captured.input !== 'string' ||
    inputs === undefined ||
    inputs.fingerprint !== captured.input
  )
    throw new Error(`captureReviewInput refused: ${JSON.stringify(captured)}`)
  return { input: captured.input, inputs }
}

async function prepare(box: Box, cwd: string, armed = false, beforeCapture?: () => void): Promise<void> {
  const head = box.sha[BRANCH] as string
  const base = box.sha.main as string
  const authority = linkedLandingAuthority({
    repository: 'acme/app',
    issueNumber: ISSUE,
    prNumber: PR,
    branch: BRANCH,
    base: 'main',
    issueBody: LANDING_SPEC.body,
    ownSpec: LANDING_SPEC.ownSpec,
    lineageHead: base,
    author: 'operator',
  })
  const fixtures = roxabiWorkflowFixtures()
  const plan = eligiblePlan(authority.mandate, [fixtures.historyFrom([authority.mandate])]).map((record) => {
    if (record.kind !== 'action-receipt') return record
    const previous = record.payload.inputs
    const manifest = {
      ...previous.manifest,
      code: { repository: ISSUE_SCOPE.repository, base, head: base, referenceCommit: base },
    }
    const built = buildRecord({
      ...record,
      payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
    })
    if (!built.ok) throw new Error(`Invalid landing plan ${JSON.stringify(built.diagnostics)}`)
    return built.value
  })
  const observe = (sha: string) => {
    const [actual, ...parents] = git(box, cwd, ['rev-list', '--parents', '-n1', sha]).split(' ')
    if (actual !== sha) throw new Error('Wrong selected-base fixture commit')
    return {
      sha,
      parents,
      tree: git(box, cwd, ['rev-parse', `${sha}^{tree}`]),
      subject: git(box, cwd, ['show', '-s', '--format=%s', sha]),
      paths: git(box, cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean),
      config: git(box, cwd, ['show', `${sha}:.dev/stack.yml`]),
    }
  }
  const pullScope = { repository: 'acme/app', target: `acme/app#${PR}` }
  const pullHistory = decodeHistory({
    scope: pullScope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
  const rangeCommits = git(box, cwd, ['rev-list', '--reverse', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
  const issueRecords = (
    await nativeImplementationWorld({
      graph: graphFromSimulatedIssues(ISSUE_SCOPE, [
        {
          number: ISSUE,
          title: 'fix: plain',
          body: LANDING_SPEC.body,
          updatedAt: '2026-10-27T12:00:00Z',
          state: 'OPEN',
          stateReason: null,
          labels: ['size:S'],
          subIssues: [],
          blockedBy: [],
        },
      ]),
      histories: [fixtures.historyFrom(plan), pullHistory],
      scope: ISSUE_SCOPE,
      mandate: authority.mandate,
      startHead: base,
      head,
      branch: BRANCH,
      author: 'operator',
      authorization: { repositoryId: 1, operatorId: 101, appId: 200, botUserId: 201 },
      command: 'bun test plain.test.ts',
      output: 'PASS plain',
      commits: [observe(base), ...rangeCommits.map(observe)],
      comparisons: [
        { base, head: base, status: 'identical', commits: [] },
        { base, head, status: rangeCommits.length ? 'ahead' : 'identical', commits: rangeCommits },
      ],
      baseTip: base,
      remoteTipBefore: base,
      remoteTipAfter: head,
      pullRequestsBefore: [
        {
          scope: pullScope,
          branch: BRANCH,
          base: 'main',
          head: base,
          baseTip: base,
          state: 'OPEN',
          mergeCommit: null,
          gate: { labels: [], autoMerge: null },
          author: 'operator',
        },
      ],
      pullRequestsAfter: [
        {
          scope: pullScope,
          branch: BRANCH,
          base: 'main',
          head,
          baseTip: base,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
    })
  ).records
  const issueBodies = roxabiWorkflowFixtures().framedBodies(issueRecords, 'operator')
  writeSim(box, (state) => {
    const pull = state.prs[String(PR)]
    const issue = state.issues[String(ISSUE)]
    if (!pull || !issue) throw new Error('landing fixture scope missing')
    issue.comments = issueBodies.map((body) => ({ author: 'operator', body }))
    pull.comments = authority.bindingBodies.map((body) => ({ author: 'operator', body }))
    issue.body = LANDING_SPEC.body
    pull.labels = armed ? ['reviewed'] : []
    pull.autoMerge = armed ? { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: head } : null
    pull.baseRefName = 'main'
    pull.headRefName = BRANCH
    pull.headRefOid = head
    pull.state = 'OPEN'
    pull.mergeCommit = null
    pull.mergedAt = null
  })
  beforeCapture?.()
  const captured = captureInput(box, cwd, head)
  const pull = readSim(box).prs[String(PR)]
  if (!pull) throw new Error('landing fixture PR missing')
  const review = criterionReviewGraph({
    mandate: authority.mandate,
    issueRecords,
    pullHistory: criterionPullHistory({ repository: 'acme/app', target: `acme/app#${PR}` }, pull.comments),
    scope: { repository: 'acme/app', target: `acme/app#${PR}` },
    head,
    inputs: captured.inputs,
    projection,
    graph: graphFromSimulatedIssues(ISSUE_SCOPE, Object.values(readSim(box).issues)),
    contextHistories: [],
    author: 'operator',
    verdict: 'Approve (clean)',
    prefix: 'selected-base',
  })
  writeSim(box, (state) => {
    const pull = state.prs[String(PR)]
    if (!pull) throw new Error('missing pull')
    const issue = state.issues[String(ISSUE)]
    if (!issue) throw new Error('missing origin issue')
    issue.comments.push(...review.issueComments.map(({ body }) => ({ author: 'operator', body })))
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

function mutateAfter(
  box: Box,
  when: 'label' | 'grant' | 'pin' | 'review-input',
  change: string,
  failFetch = false,
): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), 'omp-selected-base-'))
  const shim = path.join(dir, 'gh')
  const originalPath = box.env.PATH
  writeFileSync(
    shim,
    `#!${BUN}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const reviewInput = args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,baseRefName')
const output = spawnSync('gh', args, { env: { ...process.env, PATH: ${JSON.stringify(originalPath)} }, stdio: 'inherit' })
const marker = ${JSON.stringify(path.join(dir, 'mutated'))}
const pending = marker + '-pending'
if (${JSON.stringify(when)} === 'grant' && output.status === 0 && args[0] === 'api' && args.includes('POST') && args.some((arg) => arg.startsWith('body=<!-- kit-head-authorization:v1 -->'))) writeFileSync(pending, 'posted')
const match = ${JSON.stringify(when)} === 'grant'
  ? existsSync(pending) && args[0] === 'api' && args.includes('graphql') && args.some((arg) => arg.includes('... on IssueComment'))
  : ${JSON.stringify(when)} === 'label'
    ? args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label')
    : ${JSON.stringify(when)} === 'pin'
      ? args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')
    : reviewInput
if (output.status === 0 && match && !existsSync(marker)) {
  const state = JSON.parse(readFileSync(process.env.GH_SIM_STATE, 'utf8'))
  ${change}
  writeFileSync(process.env.GH_SIM_STATE, JSON.stringify(state))
  writeFileSync(marker, 'done')
}
process.exit(output.status ?? 1)
`,
  )
  chmodSync(shim, 0o755)
  if (failFetch) {
    const gitShim = path.join(dir, 'git')
    writeFileSync(
      gitShim,
      `#!${BUN}
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
if (existsSync(${JSON.stringify(path.join(dir, 'mutated'))}) && args.includes('fetch')) process.exit(1)
const result = spawnSync('git', args, { env: { ...process.env, PATH: ${JSON.stringify(originalPath)} }, stdio: 'inherit' })
process.exit(result.status ?? 1)
`,
    )
    chmodSync(gitShim, 0o755)
  }
  box.env.PATH = `${dir}:${originalPath}`
  return () => {
    box.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('landPr retains the selected base name and tip', () => {
  it.each(['native', 'merge-on-green'] as const)('%s keeps watching when nothing moves', async (mode) => {
    const { box, cwd } = createBox(mode)
    await prepare(box, cwd)

    const run = land(box, cwd, mode)

    expect(run.result).toMatchObject({ status: 'watching', mode })
    expect(run.pull.labels).toEqual(mode === 'native' ? ['reviewed'] : [])
    expect(run.pull.autoMerge).toEqual(
      mode === 'native' ? expect.objectContaining({ matchHeadCommit: box.sha[BRANCH] }) : null,
    )
  })

  it.each(['native', 'merge-on-green'] as const)('%s preserves the selected tip for a green PR', async (mode) => {
    const { box, cwd } = createBox(mode)
    await prepare(box, cwd)
    green(box)

    const run = land(box, cwd, mode)

    expect(run.result.status).toBe(mode === 'native' ? 'merged' : 'watching')
    if (mode === 'native') {
      expect(run.pull.state).toBe('MERGED')
      expect(run.pull.mergeCommit?.parents).toEqual([box.sha.main, box.sha[BRANCH]])
    } else {
      expect(run.pull.state).toBe('OPEN')
      const grant = run.pull.comments.find((comment) => comment.body.startsWith('<!-- kit-head-authorization:v1 -->\n'))
      if (!grant) throw new Error('authorization grant missing')
      expect(JSON.parse(grant.body.split('\n')[1])).toMatchObject({
        kind: 'grant',
        headSha: box.sha[BRANCH],
        baseRef: 'main',
        baseSha: box.sha.main,
      })
    }
  })

  it('admits a fresh native review against the live advanced base, not cached PR base metadata', async () => {
    const { box, cwd } = createBox('merge-on-green')
    writeSim(box, (state) => {
      state.prs[String(PR)].baseRecord = { at: `main@${box.sha[BRANCH]}`, oid: box.sha.main }
    })
    await prepare(box, cwd, false, () => {
      git(box, cwd, ['--git-dir', box.origin, 'update-ref', 'refs/heads/main', box.sha.staging as string])
    })
    const run = land(box, cwd, 'merge-on-green')
    expect(run.result.status).toBe('watching')
    const grant = run.pull.comments.find((comment) => comment.body.startsWith('<!-- kit-head-authorization:v1 -->\n'))
    if (!grant) throw new Error('authorization grant missing')
    expect(JSON.parse(grant.body.split('\n')[1])).toMatchObject({
      kind: 'grant',
      headSha: box.sha[BRANCH],
      baseRef: 'main',
      baseSha: box.sha.staging,
    })
  })

  it('refuses the previous review when the live base advances after approval', async () => {
    const { box, cwd } = createBox('merge-on-green')
    writeSim(box, (state) => {
      state.prs[String(PR)].baseRecord = { at: `main@${box.sha[BRANCH]}`, oid: box.sha.main }
    })
    await prepare(box, cwd)
    git(box, cwd, ['--git-dir', box.origin, 'update-ref', 'refs/heads/main', box.sha.staging as string])

    const run = land(box, cwd, 'merge-on-green')

    expect(run.result).toMatchObject({ status: 'review-input-refused', reason: 'review-input-changed' })
    expect(run.pull.autoMerge).toBeNull()
    expect(
      run.pull.comments.some(
        (comment) =>
          comment.body.startsWith('<!-- kit-head-authorization:v1 -->\n') &&
          JSON.parse(comment.body.split('\n')[1]).kind === 'grant',
      ),
    ).toBe(false)
  })

  it('reports merged when native auto-merge completes during post-write observation', async () => {
    const { box, cwd } = createBox()
    await prepare(box, cwd)
    green(box)

    const run = land(box, cwd, 'native')

    expect(run.result).toEqual({ status: 'merged' })
    expect(run.pull.state).toBe('MERGED')
    expect(run.calls.some((args) => args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label'))).toBe(false)
    expect(run.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto'))).toHaveLength(
      1,
    )
  })

  it('refuses native landing once it merged onto a base moved after selection', async () => {
    const { box, cwd } = createBox()
    await prepare(box, cwd)
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

  it('refuses a merge-on-green wrong-head merge instead of claiming watching or merged', async () => {
    const { box, cwd } = createBox('merge-on-green')
    await prepare(box, cwd)
    green(box)
    const h2 = box.sha[NEXT] as string
    green(box, h2)
    const restore = mutateAfter(
      box,
      'grant',
      `state.prs[${PR}].headRefOid = ${JSON.stringify(h2)}; state.prs[${PR}].headRefName = ${JSON.stringify(NEXT)}`,
    )
    try {
      const run = land(box, cwd, 'merge-on-green')
      expect(run.result).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
    } finally {
      restore()
    }
  })

  it('does not claim merged or watching when a native post-admit race changes the head', async () => {
    const { box, cwd } = createBox()
    await prepare(box, cwd)
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

  it('does not claim merged or watching when admission never succeeds and a prior arm settles onto the tip', async () => {
    const { box, cwd } = createBox()
    await prepare(box, cwd, true)
    green(box)
    const restore = mutateAfter(box, 'review-input', `state.prs[${PR}].baseRefName = 'staging'`)
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

  it.each(['native', 'merge-on-green'] as const)('%s refuses an unreadable selected base tip', async (mode) => {
    const { box, cwd } = createBox(mode)
    await prepare(box, cwd)
    const restore = mutateAfter(box, mode === 'native' ? 'label' : 'grant', '', true)
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
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a fork origin before it reads the base policy',
    async (mode) => {
      const { box, cwd } = createBox(mode)
      await prepare(box, cwd)
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
    },
  )
})
