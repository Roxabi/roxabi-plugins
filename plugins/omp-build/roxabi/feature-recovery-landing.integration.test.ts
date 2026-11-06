import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { actionInputDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { criterionPullHistory, criterionReviewGraph } from '../testing/criterion-approval.ts'
import { graphFromSimulatedIssues } from '../testing/criterion-dispositions.ts'
import { cleanupFeatureRecoveryRoots, trackFeatureRecoveryRoot } from '../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { nativeImplementationWorld } from '../testing/native-implementation-world.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { git, readSim, sandbox, WORKFLOW, worktree, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'
import { eligiblePlan } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { coldCheckout, effectCalls, invoke } from './feature-recovery-process-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const { projection } = roxabiRecordFixtures()
const { framedBodies, linkedLandingAuthority } = roxabiWorkflowFixtures()
afterEach(cleanupFeatureRecoveryRoots)

function plainSpec() {
  return {
    base: {
      '.dev/stack.yml': 'landing:\n  mode: merge-on-green\nrelease:\n  model: trunk\n',
      'src/a.ts': 'export const add = (a, b) => a + b\n',
    },
    branches: [
      {
        name: 'fix/5-plain',
        from: 'main',
        commits: [
          {
            message: 'fix: plain (#5)',
            files: { 'src/a.ts': 'export const add = (a, b) => a + b\nexport const plain = true\n' },
          },
        ],
      },
    ],
    issues: [{ number: 5, title: 'fix: plain', issueType: 'fix', labels: ['size:S'] }],
    prs: [{ number: 30, branch: 'fix/5-plain', title: 'fix: plain', body: 'Closes #5\n', closes: [5] }],
  }
}

function workflowRead(box: Box, cwd: string, pr: number, head: string) {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`captureReviewInput failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as { ok: boolean; input?: string | null; inputs?: ActionInputs; reason?: string }
}

function land(box: Box, cwd: string, pr: number): { status: string } {
  const run = spawnSync(
    BUN,
    [WORKFLOW, 'landPr', cwd, JSON.stringify({ pr, landing: { mode: 'native', required_checks: ['ci'] } })],
    { cwd, env: box.env, encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`landPr failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as { status: string }
}

describe('feature recovery native landing witness', () => {
  it('cold-observes a real MERGED native landing without new effects', async () => {
    const box = sandbox(plainSpec())
    trackFeatureRecoveryRoot(box.root)
    git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const pr = 30
    const issueNumber = 5
    const branch = 'fix/5-plain'
    const head = box.sha[branch]
    const baseTip = box.sha.main
    if (head === undefined || baseTip === undefined) throw new Error('plain landing fixture missing commit')
    const checkout = worktree(box, 'merged-landing', head)
    const issue = readSim(box).issues[String(issueNumber)]
    if (issue === undefined) throw new Error('plain landing fixture missing issue')
    const landingScope = { repository: 'acme/app', target: `acme/app#${issueNumber}` }
    const landingSpec = nativeFeatureSpec(landingScope, 'lands')
    writeSim(box, (state) => {
      const linkedIssue = state.issues[String(issueNumber)]
      if (linkedIssue === undefined) throw new Error('plain landing fixture missing issue')
      linkedIssue.body = landingSpec.body
    })
    const authority = linkedLandingAuthority({
      repository: 'acme/app',
      issueNumber,
      prNumber: pr,
      branch,
      base: 'main',
      issueBody: landingSpec.body,
      ownSpec: landingSpec.ownSpec,
      lineageHead: baseTip,
      author: 'operator',
    })
    const plan = eligiblePlan(authority.mandate, [roxabiWorkflowFixtures().historyFrom([authority.mandate])]).map(
      (record) => {
        if (record.kind !== 'action-receipt') return record
        const previous = record.payload.inputs
        const manifest = {
          ...previous.manifest,
          code: { repository: landingScope.repository, base: baseTip, head: baseTip, referenceCommit: baseTip },
        }
        const built = buildRecord({
          ...record,
          payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
        })
        if (!built.ok) throw new Error(`Invalid landing plan ${JSON.stringify(built.diagnostics)}`)
        return built.value
      },
    )
    const observeCommit = (sha: string) => {
      const [actual, ...parents] = git(box, checkout, ['rev-list', '--parents', '-n1', sha]).split(' ')
      if (actual !== sha) throw new Error('Wrong landing fixture commit')
      return {
        sha,
        parents,
        tree: git(box, checkout, ['rev-parse', `${sha}^{tree}`]),
        subject: git(box, checkout, ['show', '-s', '--format=%s', sha]),
        paths: git(box, checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
          .split('\n')
          .filter(Boolean),
        config: git(box, checkout, ['show', `${sha}:.dev/stack.yml`]),
      }
    }
    const pullScope = { repository: 'acme/app', target: `acme/app#${pr}` }
    const pullHistory = decodeHistory({
      scope: pullScope,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    })
    const rangeCommits = git(box, checkout, ['rev-list', '--reverse', `${baseTip}..${head}`])
      .split('\n')
      .filter(Boolean)
    const issueRecords = (
      await nativeImplementationWorld({
        graph: graphFromSimulatedIssues(landingScope, Object.values(readSim(box).issues)),
        histories: [roxabiWorkflowFixtures().historyFrom(plan), pullHistory],
        scope: landingScope,
        mandate: authority.mandate,
        startHead: baseTip,
        head,
        branch,
        command: 'bun test plain.test.ts',
        output: 'PASS plain',
        author: 'operator',
        commits: [observeCommit(baseTip), ...rangeCommits.map(observeCommit)],
        comparisons: [
          { base: baseTip, head: baseTip, status: 'identical', commits: [] },
          { base: baseTip, head, status: rangeCommits.length ? 'ahead' : 'identical', commits: rangeCommits },
        ],
        baseTip,
        remoteTipBefore: baseTip,
        remoteTipAfter: head,
        pullRequestsBefore: [
          {
            scope: pullScope,
            branch,
            base: 'main',
            head: baseTip,
            baseTip,
            state: 'OPEN',
            mergeCommit: null,
            author: 'operator',
          },
        ],
        pullRequestsAfter: [
          {
            scope: pullScope,
            branch,
            base: 'main',
            head,
            baseTip,
            state: 'OPEN',
            mergeCommit: null,
            author: 'operator',
          },
        ],
      })
    ).records
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      const linkedIssue = state.issues[String(issueNumber)]
      if (pull === undefined || linkedIssue === undefined) throw new Error('plain landing authority endpoints missing')
      pull.comments = authority.bindingBodies.map((body) => ({ author: 'operator', body }))
      linkedIssue.comments = framedBodies(issueRecords, 'operator').map((body) => ({ author: 'operator', body }))
    })
    const captured = workflowRead(box, checkout, pr, head)
    if (captured.ok !== true || typeof captured.input !== 'string' || captured.inputs === undefined) {
      throw new Error(`captureReviewInput refused: ${JSON.stringify(captured)}`)
    }
    const inputs = captured.inputs
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (pull === undefined) throw new Error('plain landing PR missing')
      const issue = state.issues[String(issueNumber)]
      if (issue === undefined) throw new Error('plain landing origin missing')
      const review = criterionReviewGraph({
        mandate: authority.mandate,
        issueRecords,
        pullHistory: criterionPullHistory({ repository: 'acme/app', target: `acme/app#${pr}` }, pull.comments),
        scope: { repository: 'acme/app', target: `acme/app#${pr}` },
        head,
        inputs,
        projection,
        graph: graphFromSimulatedIssues(landingScope, Object.values(state.issues)),
        contextHistories: [],
        author: 'operator',
        verdict: 'Approve (clean)',
        prefix: 'feature-recovery-merged',
      })
      issue.comments.push(...review.issueComments.map(({ body }) => ({ author: 'operator', body })))
      pull.comments.push(...review.comments.map(({ body }) => ({ author: 'operator', body })))
      state.checks[head] = [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          workflowName: 'ci',
          startedAt: '2026-01-01T00:00:00Z',
        },
      ]
    })
    expect(land(box, checkout, pr)).toEqual({ status: 'merged' })
    const merged = readSim(box).prs[String(pr)]
    expect(merged?.state).toBe('MERGED')
    expect(merged?.mergeCommit?.parents).toEqual([baseTip, head])
    expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', 'refs/heads/main'])).toBe(merged?.mergeCommit?.oid)
    expect(readSim(box).issues[String(issueNumber)]).toMatchObject({ state: 'CLOSED', stateReason: 'COMPLETED' })

    const cold = coldCheckout(box, 'merged-cold', branch)
    const callsBefore = readSim(box).calls.length
    expect(
      invoke<{ kind: string; reason: string }>(box, cold, path.join(box.root, 'home-merged-cold'), 'watch', {
        pr,
        code: 0,
        reference: '#5',
      }),
    ).toMatchObject({ kind: 'terminal', reason: 'done' })
    expect(readSim(box).issues[String(issueNumber)]).toMatchObject({ state: 'CLOSED', stateReason: 'COMPLETED' })
    expect(effectCalls(box, callsBefore)).toEqual([])
  })
})
