import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { git, readSim, sandbox, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { eligiblePlan } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'

const runner = path.resolve(import.meta.dirname, '../../testing/feature-recovery-runner.ts')
const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const scope = { repository: 'acme/app', target: 'acme/app#42' }
const branch = 'feat/42-save'
const roots = new Set<string>()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('retains captured implementation evidence with a host authority-withdrawal code after a real pause', () => {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'README.md': 'base\n' },
    branches: [{ name: branch, from: 'main', commits: [] }],
    issues: [{ number: 42, title: 'feat: preserve region', labels: ['size:S'] }],
    prs: [],
  })
  roots.add(box.root)
  git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const checkout = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', checkout, branch])
  const spec = nativeFeatureSpec(scope, 'preserves the region')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    branch,
    body: spec.body,
    ownSpec: spec.ownSpec,
    lineageHead: box.sha.main,
  })
  const records = eligiblePlan(mandate, [fixtures.historyFrom([mandate])])
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (issue === undefined) throw new Error('missing issue')
    issue.body = spec.body
    issue.comments.push(...fixtures.framedBodies(records, 'operator').map((body) => ({ author: 'operator', body })))
  })
  const remoteBefore = git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${branch}`])
  const home = path.join(box.root, 'home')
  mkdirSync(home, { recursive: true })
  const run = spawnSync(bun, [runner, 'omp-live-interleave', checkout, '{}'], {
    cwd: checkout,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${run.stderr}\n${run.stdout}`)
  const observed = JSON.parse(run.stdout) as {
    operationId: string
    pushAttempted: boolean
    completionError: string | null
  }
  expect(observed.completionError).toBeNull()
  expect(observed.pushAttempted).toBe(false)
  expect(git(box, box.root, ['--git-dir', box.origin, 'rev-parse', `refs/heads/${branch}`])).toBe(remoteBefore)
  const history = decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
      locator: `acme/app#42:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    diagnostics: [],
  })
  const results = history.operations.flatMap(({ record }) =>
    record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result'
      ? [record]
      : [],
  )
  expect(results).toHaveLength(1)
  expect(results[0]?.payload).toMatchObject({
    actionId: observed.operationId,
    native: {
      completion: 'completed',
      strict: 'valid',
      bashCalls: expect.arrayContaining([
        expect.objectContaining({ toolCallId: 'implementation-proof-red', exitCode: 1 }),
        expect.objectContaining({ toolCallId: 'implementation-proof-green', exitCode: 0 }),
      ]),
    },
    admission: { admitted: false, published: false, reason: 'implementation-local-inhibition' },
  })
})
