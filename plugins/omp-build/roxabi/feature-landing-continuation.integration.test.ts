import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { criterionReviewGraph } from '../testing/criterion-approval.ts'
import { graphFromSimulatedIssues } from '../testing/criterion-dispositions.ts'
import { cleanupFeatureRecoveryRoots, trackFeatureRecoveryRoot } from '../testing/feature-recovery-fixture.ts'
import {
  arrangeReviewFixture,
  REVIEW_BRANCH,
  REVIEW_SCOPE,
  seedReviewFixture,
} from '../testing/feature-review-fixture.ts'
import { roxabiRecordFixtures } from '../testing/roxabi-presets.ts'
import { git, readSim, WORKFLOW, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'
import { invoke } from './feature-recovery-process-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PULL = { repository: 'acme/app', target: 'acme/app#7' }
/** Field list of the landing gate read (`readGate`); the engine's green-CI observation never selects it. */
const LANDING_GATE_FIELDS = 'headRefOid,state,labels,autoMergeRequest,mergeStateStatus'
const CONTINUE = { reference: '#42', control: 'continue' }
const { projection } = roxabiRecordFixtures()
afterEach(cleanupFeatureRecoveryRoots)

type Result = { kind: string; reason?: string; next?: string; diagnostics?: { code: string; message: string }[] }

function history(box: Box, target: 'issue' | 'pull') {
  const scope = target === 'issue' ? REVIEW_SCOPE : PULL
  // The simulator assigns native IDs and immutable timestamps when GH first reads seeded comments.
  execFileSync('gh', ['api', `repos/acme/app/issues/${target === 'issue' ? 42 : 7}/comments?per_page=100&page=1`], {
    cwd: box.principal,
    env: box.env,
    encoding: 'utf8',
  })
  const comments = target === 'issue' ? readSim(box).issues['42']?.comments : readSim(box).prs['7']?.comments
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: (comments ?? []).map((comment, index) => ({
      locator: `${scope.target}:comment:${comment.id ?? index + 1}`,
      nativeId: comment.id === undefined ? null : String(comment.id),
      body: comment.body,
      author: comment.author,
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  })
}

function mandate(box: Box) {
  const record = history(box, 'issue').operations.find((operation) => operation.record?.kind === 'mandate')?.record
  if (record?.kind !== 'mandate') throw new Error('feature mandate missing')
  return record
}

function operatorControls(box: Box): string[] {
  return history(box, 'issue').operations.flatMap((operation) =>
    operation.record?.kind === 'operator-control' ? [operation.record.payload.control] : [],
  )
}

function captureInputs(box: Box, cwd: string, head: string): ActionInputs {
  const run = spawnSync(BUN, [WORKFLOW, 'captureReviewInput', cwd, JSON.stringify({ pr: 7, head })], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`capture review input failed: ${run.stderr}`)
  const captured = JSON.parse(run.stdout) as { ok?: boolean; inputs?: ActionInputs }
  if (!captured.ok || !captured.inputs) throw new Error(`review input unavailable: ${run.stdout}`)
  return captured.inputs
}

function approve(box: Box, cwd: string): void {
  const head = box.sha[REVIEW_BRANCH]
  if (!head) throw new Error('feature head missing')
  const issueHistory = history(box, 'issue')
  const review = criterionReviewGraph({
    mandate: mandate(box),
    issueRecords: issueHistory.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
    issueHistory,
    pullHistory: history(box, 'pull'),
    scope: PULL,
    head,
    inputs: captureInputs(box, cwd, head),
    projection,
    graph: graphFromSimulatedIssues(REVIEW_SCOPE, Object.values(readSim(box).issues)),
    contextHistories: [],
    author: 'operator',
    verdict: 'Approve (clean)',
    prefix: 'landing-continuation-review',
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    const pull = state.prs['7']
    if (!issue || !pull) throw new Error('review endpoints missing')
    issue.comments.push(...review.issueComments.map(({ body }) => ({ author: 'operator', body })))
    pull.comments.push(
      ...review.comments.map(({ body }) => ({
        author: 'operator',
        body,
        createdAt: '2026-10-22T11:00:00Z',
        updatedAt: '2026-10-22T11:00:00Z',
      })),
    )
  })
}

function setGreenCi(box: Box): void {
  const head = box.sha[REVIEW_BRANCH]
  if (!head) throw new Error('feature head missing')
  writeSim(box, (state) => {
    state.checks[head] = [
      {
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        workflowName: 'ci',
        startedAt: '2026-10-22T12:00:00Z',
      },
    ]
  })
}

/** One current approval and green CI on the bound pull request: the engine selects `land`. */
async function approvedGreenFixture(): Promise<{ box: Box; cwd: string }> {
  const { box, cwd } = arrangeReviewFixture()
  trackFeatureRecoveryRoot(box.root)
  await seedReviewFixture(box, cwd)
  approve(box, cwd)
  setGreenCi(box)
  return { box, cwd }
}

/** A real commit on top of the reviewed head, present in origin under a side ref only. */
function pushMovedHead(box: Box): string {
  const head = box.sha[REVIEW_BRANCH]
  if (!head) throw new Error('feature head missing')
  const scratch = path.join(box.root, 'moved-head')
  git(box, box.principal, ['worktree', 'add', '-q', '--detach', scratch, head])
  writeFileSync(path.join(scratch, 'src', 'moved.ts'), 'export const moved = true\n')
  git(box, scratch, ['add', '-A'])
  git(box, scratch, ['commit', '-qm', 'feat: move the head under landing (#42)'])
  git(box, scratch, ['push', '-q', 'origin', 'HEAD:refs/heads/moved-head'])
  return git(box, scratch, ['rev-parse', 'HEAD'])
}

/**
 * GitHub-boundary injection on the landing gate read only:
 * - `behind`: GitHub reports the pull request behind its base;
 * - `moved-view`: landing observes a newer head the engine's own reads do not see yet;
 * - `moved-push`: the head really moves (origin ref and pull request) when landing first reads its gate.
 */
function interceptLandingGate(box: Box, mode: 'behind' | 'moved-view' | 'moved-push', moved = ''): string {
  const realGh = execFileSync('which', ['gh'], { env: box.env, encoding: 'utf8' }).trim()
  const bin = path.join(box.root, 'landing-gate-bin')
  mkdirSync(bin)
  const flag = path.join(box.root, 'landing-head-moved')
  const wrapper = path.join(bin, 'gh')
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'case " $* " in',
      `  *" pr view "*" ${LANDING_GATE_FIELDS} "*)`,
      '    case "$LANDING_GATE_MODE" in',
      '      behind)',
      '        out=$("$LANDING_REAL_GH" "$@") || exit $?',
      `        printf '%s\\n' "$out" | jq -c '.mergeStateStatus = "BEHIND"'`,
      '        exit $?;;',
      '      moved-view)',
      '        out=$("$LANDING_REAL_GH" "$@") || exit $?',
      `        printf '%s\\n' "$out" | jq -c --arg sha "$LANDING_MOVED_HEAD" '.headRefOid = $sha'`,
      '        exit $?;;',
      '      moved-push)',
      '        if [ ! -e "$LANDING_MOVED_FLAG" ]; then',
      '          : > "$LANDING_MOVED_FLAG"',
      '          git --git-dir "$LANDING_ORIGIN" update-ref "refs/heads/$LANDING_BRANCH" "$LANDING_MOVED_HEAD" || exit 70',
      `          jq --arg sha "$LANDING_MOVED_HEAD" '.prs["7"].headRefOid = $sha' "$GH_SIM_STATE" > "$GH_SIM_STATE.moved" || exit 70`,
      '          mv "$GH_SIM_STATE.moved" "$GH_SIM_STATE" || exit 70',
      '        fi;;',
      '    esac;;',
      'esac',
      'exec "$LANDING_REAL_GH" "$@"',
      '',
    ].join('\n'),
  )
  chmodSync(wrapper, 0o755)
  box.env.PATH = `${bin}:${box.env.PATH}`
  Object.assign(box.env, {
    LANDING_REAL_GH: realGh,
    LANDING_GATE_MODE: mode,
    LANDING_MOVED_HEAD: moved,
    LANDING_MOVED_FLAG: flag,
    LANDING_ORIGIN: box.origin,
    LANDING_BRANCH: REVIEW_BRANCH,
  })
  return flag
}

/** Effects a held landing must leave to the operator: no branch update, merge or auto-merge arming. */
function landingEffects(box: Box, start: number): string[][] {
  return readSim(box)
    .calls.slice(start)
    .filter((args) => {
      const joined = args.join(' ')
      return (
        joined.includes('update-branch') ||
        joined.includes('updatePullRequestBranch') ||
        joined.includes('enablePullRequestAutoMerge') ||
        joined.includes('mergePullRequest') ||
        (args[0] === 'pr' && args[1] === 'merge')
      )
    })
}

const BEHIND_HOLD = {
  kind: 'blocked',
  reason: 'behind',
  next: 'update-branch-then-land',
  diagnostics: [{ code: 'behind', message: expect.stringContaining('gh pr update-branch 7') }],
}

describe('landing continuation through public Feature continuation', () => {
  it('holds a behind landing with its next decision instead of ending the feature', async () => {
    const { box, cwd } = await approvedGreenFixture()
    interceptLandingGate(box, 'behind')
    const start = readSim(box).calls.length

    const result = invoke<Result>(box, cwd, path.join(box.root, 'home-behind'), 'continue', CONTINUE)

    expect(result).toEqual(BEHIND_HOLD)
    expect(landingEffects(box, start)).toEqual([])
    expect(readSim(box).prs['7']).toMatchObject({ state: 'OPEN', autoMerge: null })
  })

  it('lets the owning OMP session pause a held behind landing on a user interrupt', async () => {
    const { box, cwd } = await approvedGreenFixture()
    interceptLandingGate(box, 'behind')

    const observed = invoke<{ messages: string[] }>(box, cwd, path.join(box.root, 'home-held-pause'), 'omp-pause', {})

    expect(observed.messages).toContainEqual(
      expect.stringMatching(/^feature-held: behind\nnext: update-branch-then-land(\n|$)/),
    )
    expect(observed.messages).toContain('pause-confirmed: pause-confirmed')
    expect(operatorControls(box)).toContain('pause-confirmed')
  })

  it('refuses to land twice in one call when only landing sees the moved head', async () => {
    const { box, cwd } = await approvedGreenFixture()
    interceptLandingGate(box, 'moved-view', pushMovedHead(box))
    const start = readSim(box).calls.length

    const result = invoke<Result>(box, cwd, path.join(box.root, 'home-moved-view'), 'continue', CONTINUE)

    expect(result).toEqual({ kind: 'blocked', reason: 'land-repeat-refused:head-moved', next: 'feature-reentry' })
    expect(landingEffects(box, start)).toEqual([])
  })

  it('routes a head that moved under landing to the decision a fresh engine continuation takes', async () => {
    const { box, cwd } = await approvedGreenFixture()
    const moved = pushMovedHead(box)
    const flag = interceptLandingGate(box, 'moved-push', moved)
    const home = path.join(box.root, 'home-moved-push')

    const reentered = invoke<Result>(box, cwd, home, 'continue', CONTINUE)

    expect(existsSync(flag)).toBe(true)
    expect(readSim(box).prs['7']?.headRefOid).toBe(moved)
    expect(reentered).not.toMatchObject({
      kind: 'blocked',
      reason: expect.stringMatching(/^(next-review-step|land-repeat-refused)/),
    })
    const fresh = invoke<Result>(box, cwd, home, 'continue', CONTINUE)
    expect(reentered).toEqual(fresh)
  })

  it.each([
    [5, { kind: 'blocked', reason: 'timeout', next: 'feature-reentry' }],
    [6, { kind: 'blocked', reason: 'evaluate-only', next: 'manual-merge' }],
    [7, BEHIND_HOLD],
  ] as const)('holds watch exit %i with the decision it leaves open', async (code, expected) => {
    const { box, cwd } = await approvedGreenFixture()
    const start = readSim(box).calls.length

    const result = invoke<Result>(box, cwd, path.join(box.root, `home-watch-${code}`), 'watch', {
      reference: '#42',
      pr: 7,
      code,
    })

    expect(result).toEqual(expected)
    expect(landingEffects(box, start)).toEqual([])
  })
})
