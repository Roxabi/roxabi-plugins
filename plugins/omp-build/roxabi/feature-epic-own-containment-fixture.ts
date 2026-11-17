import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect } from 'vitest'
import { effectiveMandateRole, resolveAcceptedSpec } from '../contracts.ts'
import {
  acceptedMaterialState,
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../engine/__tests__/workflow-spec-assessment-support.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { selectWorkflowBinding } from '../engine/workflow-pr-binding.ts'
import { nativeFeatureSpec } from '../testing/feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { git, sandbox, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'
import { legacyFixtures } from './__tests__/uw-successor-selection-support.ts'

const RUNNER = path.resolve(import.meta.dirname, '../testing/feature-recovery-runner.ts')
const ABANDON = path.resolve(import.meta.dirname, './feature-containment-abandon-fixture.ts')
const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const ROOT = { repository: 'acme/app', target: 'acme/app#42' }
const CHILD = { repository: 'acme/app', target: 'acme/app#43' }
const FOREIGN = { repository: 'acme/app', target: 'acme/app#44' }
const PR = { repository: 'acme/app', target: 'acme/app#7' }
const BRANCH = 'feat/44-foreign'
const ROOT_BRANCH = 'feat/42-root'
export const roots = new Set<string>()
const fixtures = roxabiWorkflowFixtures()

function abandonFixtureChild(
  box: Box,
  cwd: string,
  rootBody: string,
  childBody: string,
  rootRecords: CanonicalRecord[],
  child: CanonicalRecord,
  initialRootHistory: DecodedHistory,
  childHistory: DecodedHistory,
): DecodedHistory {
  writeSim(box, (state) => {
    const rootIssue = state.issues['42']
    const childIssue = state.issues['43']
    if (!rootIssue || !childIssue) throw new Error('missing native fixture')
    rootIssue.body = rootBody
    rootIssue.subIssues = [43]
    rootIssue.comments.push(
      ...fixtures.framedBodies(rootRecords, 'operator', [childHistory]).map((body) => ({ author: 'operator', body })),
    )
    childIssue.body = childBody
    childIssue.comments.push(
      ...fixtures.framedBodies([child], 'operator', [initialRootHistory]).map((body) => ({ author: 'operator', body })),
    )
  })
  const artifacts = path.join(box.root, 'abandon-artifacts')
  mkdirSync(artifacts, { recursive: true })
  const run = spawnSync(BUN, [ABANDON, cwd, artifacts], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`Child abandonment failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as DecodedHistory
}

export function fixture(
  owner: 'selected' | 'foreign' | 'child',
  historicalEpic = false,
  legacy = false,
): { box: Box; cwd: string } {
  const rootSpec = nativeFeatureSpec(ROOT, 'deliver the epic')
  const childSpec = nativeFeatureSpec(CHILD, 'deliver the child')
  const foreignSpec = nativeFeatureSpec(FOREIGN, 'deliver unrelated work')
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [
      { name: BRANCH, from: 'main', commits: [] },
      ...(owner === 'child' ? [{ name: ROOT_BRANCH, from: 'main', commits: [] }] : []),
    ],
    issues: [42, 43, 44].map((number) => ({ number, title: `work ${number}`, labels: ['size:S'] })),
    prs: [{ number: 7, branch: BRANCH, title: 'work', body: 'Closes #42', closes: [42] }],
  })
  roots.add(box.root)
  const cwd = path.join(box.root, 'worktree')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, BRANCH])
  const base = box.sha.main
  const head = box.sha[BRANCH]
  if (!base || !head) throw new Error('missing fixture Git commits')
  const codeRange = { repository: ROOT.repository, base, head, referenceCommit: head }
  const rootOptions = {
    body: rootSpec.body,
    ownSpec: rootSpec.ownSpec,
    branch: owner === 'child' ? ROOT_BRANCH : BRANCH,
    base: 'main',
    recordId: 'root-mandate',
    operationId: 'root-operation',
    runId: 'run00001',
    run: 'run00001',
  }
  const children = [
    { scope: CHILD, snapshot: childSpec.ownSpec.snapshot, specVersion: childSpec.ownSpec.version, tier: 'S' as const },
  ]
  const parentTemplate = fixtures.epicMandate(ROOT, children, rootOptions)
  const root = legacy
    ? legacyFixtures.epicMandate(ROOT, children, rootOptions)
    : fixtures.featureMandate(ROOT, rootOptions)
  const child = fixtures.featureMandate(CHILD, {
    body: childSpec.body,
    ownSpec: childSpec.ownSpec,
    ...(owner === 'child' ? { branch: BRANCH, base: 'main' } : {}),
    recordId: 'child-mandate',
    parent: fixtures.mandateRef(root),
    inheritedOwnSpecRefs: [
      { uw: ROOT, version: root.payload.ownSpec.version, sourceAccepted: fixtures.mandateRef(root) },
    ],
  })
  const rootRecords: CanonicalRecord[] = [root]
  let initialRootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator')
  let childHistory = fixtures.historyFrom([child], 'operator', 'operator', [initialRootHistory])
  let parentState = mandateAssessmentState(root)
  function confirmParentTransitions() {
    if (!legacy) {
      if (parentTemplate.payload.coverage === null) throw new Error('missing parent coverage')
      const proposed = {
        ...proposedAssessmentState(parentState, { body: rootSpec.body, children }),
        snapshot: parentState.snapshot,
        coverage: parentTemplate.payload.coverage,
      }
      const assessment = assessFixture(
        root,
        'root-accept-parent',
        parentState,
        proposed,
        'material',
        [initialRootHistory, childHistory],
        undefined,
        undefined,
        codeRange,
      )
      const control = acceptMaterialFixture(root, 'accept-root-parent', assessment)
      rootRecords.push(assessment.start, assessment.result, control)
      parentState = acceptedMaterialState(assessment, control)
      initialRootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator', [childHistory])
      const accepted = resolveAcceptedSpec(root, [initialRootHistory, childHistory])
      if (!accepted.ok) throw new Error(`parent acceptance refused: ${accepted.reason}`)
      expect(root.payload.role).toBe('feature')
      expect(effectiveMandateRole(root.payload.role, accepted.spec)).toBe('epic')
      childHistory = fixtures.historyFrom([child], 'operator', 'operator', [initialRootHistory])
    }
    if (historicalEpic)
      childHistory = abandonFixtureChild(
        box,
        cwd,
        rootSpec.body,
        childSpec.body,
        rootRecords,
        child,
        initialRootHistory,
        childHistory,
      )
    if (historicalEpic) {
      const initial = parentState
      const proposed = proposedAssessmentState(initial, { body: rootSpec.body, children: [] })
      const assessment = assessFixture(
        root,
        'root-accept-leaf',
        initial,
        proposed,
        'material',
        [initialRootHistory, childHistory],
        undefined,
        undefined,
        codeRange,
      )
      rootRecords.push(
        assessment.start,
        assessment.result,
        acceptMaterialFixture(root, 'accept-root-leaf', assessment, {
          scope: ROOT,
          kind: 'operator-control',
          recordId: 'accept-root-parent',
        }),
      )
      const rootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator', [childHistory])
      const accepted = resolveAcceptedSpec(root, [rootHistory, childHistory])
      if (!accepted.ok) throw new Error(`historical root acceptance refused: ${JSON.stringify(accepted)}`)
      expect(root.payload.role).toBe('feature')
      expect(effectiveMandateRole(root.payload.role, accepted.spec)).toBe('feature')
    }
  }
  confirmParentTransitions()
  const foreign = fixtures.featureMandate(FOREIGN, {
    body: foreignSpec.body,
    ownSpec: foreignSpec.ownSpec,
    branch: BRANCH,
    recordId: 'foreign-mandate',
    operationId: 'foreign-operation',
    runId: 'run00002',
    run: 'run00002',
  })
  const bound = owner === 'selected' ? root : owner === 'child' ? child : foreign
  const ownerHistory =
    owner === 'selected'
      ? fixtures.historyFrom(rootRecords, 'operator', 'operator', [childHistory])
      : owner === 'child'
        ? childHistory
        : fixtures.historyFrom([bound], 'operator', 'operator')
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
    if (owner === 'child') {
      pr.body = 'Closes #43'
      pr.closes = [43]
    }
    rootIssue.body = rootSpec.body
    rootIssue.subIssues = historicalEpic ? [] : [43]
    rootIssue.comments = fixtures
      .framedBodies(rootRecords, 'operator', [childHistory])
      .map((body) => ({ author: 'operator', body }))
    childIssue.body = childSpec.body
    if (!historicalEpic) {
      childIssue.comments.push(
        ...fixtures
          .framedBodies([child], 'operator', [initialRootHistory])
          .map((body) => ({ author: 'operator', body })),
      )
    }
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

export function control(box: Box, cwd: string, action: 'pause' | 'abandon', confirmedAbandon = false) {
  const home = path.join(box.root, `home-${action}`)
  mkdirSync(home, { recursive: true })
  const args = confirmedAbandon
    ? [ABANDON, cwd, home, 'root']
    : [RUNNER, 'continue', cwd, JSON.stringify({ reference: '#42', control: action })]
  const run = spawnSync(BUN, args, {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout)
}
