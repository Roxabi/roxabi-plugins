import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { effectiveMandateRole, resolveAcceptedSpec } from '../contracts.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../engine/__tests__/workflow-spec-assessment-support.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { selectWorkflowBinding } from '../engine/workflow-pr-binding.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { git, readSim, sandbox, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

const RUNNER = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const ROOT = { repository: 'acme/app', target: 'acme/app#42' }
const CHILD = { repository: 'acme/app', target: 'acme/app#43' }
const FOREIGN = { repository: 'acme/app', target: 'acme/app#44' }
const PR = { repository: 'acme/app', target: 'acme/app#7' }
const BRANCH = 'feat/44-foreign'
const roots = new Set<string>()
const fixtures = roxabiWorkflowFixtures()

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function fixture(owner: 'selected' | 'foreign', historicalEpic = false): { box: Box; cwd: string } {
  const rootSpec = nativeFeatureSpec(ROOT, 'deliver the epic')
  const childSpec = nativeFeatureSpec(CHILD, 'deliver the child')
  const foreignSpec = nativeFeatureSpec(FOREIGN, 'deliver unrelated work')
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [{ name: BRANCH, from: 'main', commits: [] }],
    issues: [42, 43, 44].map((number) => ({ number, title: `work ${number}`, labels: ['size:S'] })),
    prs: [{ number: 7, branch: BRANCH, title: 'work', body: 'Closes #42', closes: [42] }],
  })
  roots.add(box.root)
  const cwd = path.join(box.root, 'worktree')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, BRANCH])
  const root = fixtures.epicMandate(
    ROOT,
    [{ scope: CHILD, snapshot: childSpec.ownSpec.snapshot, specVersion: childSpec.ownSpec.version, tier: 'S' }],
    {
      body: rootSpec.body,
      ownSpec: rootSpec.ownSpec,
      recordId: 'root-mandate',
      operationId: 'root-operation',
      runId: 'run00001',
      run: 'run00001',
    },
  )
  const rootRecords: CanonicalRecord[] = [root]
  if (historicalEpic) {
    const initial = mandateAssessmentState(root)
    const proposed = proposedAssessmentState(initial, { body: rootSpec.body, children: [] })
    const assessment = assessFixture(root, 'root-accept-leaf', initial, proposed, 'material')
    rootRecords.push(assessment.start, assessment.result, acceptMaterialFixture(root, 'accept-root-leaf', assessment))
    const rootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator')
    const accepted = resolveAcceptedSpec(root, [rootHistory])
    if (!accepted.ok) throw new Error(`historical root acceptance refused: ${accepted.reason}`)
    expect(root.payload.role).toBe('epic')
    expect(effectiveMandateRole(root.payload.role, accepted.spec)).toBe('feature')
  }
  const foreign = fixtures.featureMandate(FOREIGN, {
    body: foreignSpec.body,
    ownSpec: foreignSpec.ownSpec,
    branch: BRANCH,
    recordId: 'foreign-mandate',
    operationId: 'foreign-operation',
    runId: 'run00002',
    run: 'run00002',
  })
  const bound = owner === 'selected' ? root : foreign
  const ownerHistory = fixtures.historyFrom([bound], 'operator', 'operator')
  const binding = fixtures.workflowBinding(PR, bound, BRANCH, 'main')
  const prHistory = fixtures.historyFrom([binding], 'operator', 'operator', [ownerHistory])
  expect(
    selectWorkflowBinding({
      pullRequest: PR,
      histories: [prHistory, ownerHistory],
      native: { branch: BRANCH, base: 'main' },
    }),
  ).toMatchObject({ status: 'bound', mandate: fixtures.mandateRef(bound) })
  writeSim(box, (state) => {
    const rootIssue = state.issues['42']
    const childIssue = state.issues['43']
    const foreignIssue = state.issues['44']
    const pr = state.prs['7']
    if (!rootIssue || !childIssue || !foreignIssue || !pr) throw new Error('missing native fixture')
    rootIssue.body = rootSpec.body
    rootIssue.subIssues = historicalEpic ? [] : [43]
    rootIssue.comments.push(
      ...fixtures.framedBodies(rootRecords, 'operator').map((body) => ({ author: 'operator', body })),
    )
    childIssue.body = childSpec.body
    foreignIssue.body = foreignSpec.body
    foreignIssue.comments.push(
      ...fixtures.framedBodies([foreign], 'operator').map((body) => ({ author: 'operator', body })),
    )
    pr.labels = ['reviewed']
    pr.autoMerge = { enabledAt: '2026-01-01T00:00:00Z' }
    pr.comments.push(
      ...fixtures.framedBodies([binding], 'operator', [ownerHistory]).map((body) => ({ author: 'operator', body })),
    )
  })
  return { box, cwd }
}

function control(box: Box, cwd: string, action: 'pause' | 'abandon') {
  const home = path.join(box.root, `home-${action}`)
  mkdirSync(home, { recursive: true })
  const run = spawnSync(BUN, [RUNNER, 'continue', cwd, JSON.stringify({ reference: '#42', control: action })], {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout)
}

describe('Epic own-lane containment through public controls', () => {
  it.each<'pause' | 'abandon'>(['pause', 'abandon'])(
    '%s does not disarm a foreign bound PR merely linked to the Epic',
    (action) => {
      const { box, cwd } = fixture('foreign')
      const result = control(box, cwd, action)
      const state = readSim(box)
      expect(state.prs['7']).toMatchObject({ labels: ['reviewed'], autoMerge: { enabledAt: '2026-01-01T00:00:00Z' } })
      expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
      expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: false })
    },
  )

  it.each<'pause' | 'abandon'>(['pause', 'abandon'])(
    '%s does not disarm a foreign bound PR after the Epic becomes a Feature',
    (action) => {
      const { box, cwd } = fixture('foreign', true)
      const result = control(box, cwd, action)
      const state = readSim(box)
      expect(state.prs['7']).toMatchObject({
        state: 'OPEN',
        headRefName: BRANCH,
        labels: ['reviewed'],
        autoMerge: { enabledAt: '2026-01-01T00:00:00Z' },
      })
      expect(state.calls.filter((args) => args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit'))).toEqual([])
      expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: false })
    },
  )

  it.each<'pause' | 'abandon'>(['pause', 'abandon'])(
    '%s disarms an own PR bound to the selected Epic mandate',
    (action) => {
      const { box, cwd } = fixture('selected')
      const result = control(box, cwd, action)
      const state = readSim(box)
      expect(state.prs['7']).toMatchObject({ labels: [], autoMerge: null })
      expect(state.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining(['pr', 'merge', '7', '--disable-auto']),
          expect.arrayContaining(['pr', 'edit', '7', '--remove-label', 'reviewed']),
        ]),
      )
      expect(result).toMatchObject({ kind: action === 'pause' ? 'paused' : 'abandoned', confirmed: true })
    },
  )
})
