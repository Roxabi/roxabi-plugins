import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
import { git, readSim, sandbox, writeSim } from '../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../testing/sandbox/sandbox-types.ts'

const CONTROL = path.resolve(import.meta.dirname, './feature-containment-abandon-fixture.ts')
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
  const run = spawnSync(BUN, [CONTROL, cwd, artifacts], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`Child abandonment failed: ${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as DecodedHistory
}

function fixture(owner: 'selected' | 'foreign', historicalEpic: boolean): { box: Box; cwd: string } {
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
  const base = box.sha.main
  const head = box.sha[BRANCH]
  if (!base || !head) throw new Error('missing fixture Git commits')
  const codeRange = { repository: ROOT.repository, base, head, referenceCommit: head }
  const rootOptions = {
    body: rootSpec.body,
    ownSpec: rootSpec.ownSpec,
    branch: BRANCH,
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
  const root = fixtures.featureMandate(ROOT, rootOptions)
  const child = fixtures.featureMandate(CHILD, {
    body: childSpec.body,
    ownSpec: childSpec.ownSpec,
    recordId: 'child-mandate',
    parent: fixtures.mandateRef(root),
    inheritedOwnSpecRefs: [
      { uw: ROOT, version: root.payload.ownSpec.version, sourceAccepted: fixtures.mandateRef(root) },
    ],
  })
  const rootRecords: CanonicalRecord[] = [root]
  let initialRootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator')
  let childHistory = fixtures.historyFrom([child], 'operator', 'operator', [initialRootHistory])
  const featureState = mandateAssessmentState(root)
  if (parentTemplate.payload.coverage === null) throw new Error('missing parent coverage')
  const proposedParent = {
    ...proposedAssessmentState(featureState, { body: rootSpec.body, children }),
    snapshot: featureState.snapshot,
    coverage: parentTemplate.payload.coverage,
  }
  const acceptedParent = assessFixture(
    root,
    'root-accept-parent',
    featureState,
    proposedParent,
    'material',
    [initialRootHistory, childHistory],
    undefined,
    undefined,
    codeRange,
  )
  const acceptedParentControl = acceptMaterialFixture(root, 'accept-root-parent', acceptedParent)
  rootRecords.push(acceptedParent.start, acceptedParent.result, acceptedParentControl)
  initialRootHistory = fixtures.historyFrom(rootRecords, 'operator', 'operator', [childHistory])
  const acceptedParentSpec = resolveAcceptedSpec(root, [initialRootHistory, childHistory])
  if (!acceptedParentSpec.ok) throw new Error(`parent acceptance refused: ${acceptedParentSpec.reason}`)
  expect(root.payload.role).toBe('feature')
  expect(effectiveMandateRole(root.payload.role, acceptedParentSpec.spec)).toBe('epic')
  childHistory = fixtures.historyFrom([child], 'operator', 'operator', [initialRootHistory])
  if (historicalEpic) {
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
    const initial = acceptedMaterialState(acceptedParent, acceptedParentControl)
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
  const ownerHistory =
    owner === 'selected'
      ? fixtures.historyFrom(rootRecords, 'operator', 'operator', [childHistory])
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

function abandonRoot(box: Box, cwd: string) {
  const home = path.join(box.root, 'home-abandon')
  mkdirSync(home, { recursive: true })
  const args = [CONTROL, cwd, home, 'root']
  const run = spawnSync(BUN, args, {
    cwd,
    env: { ...box.env, HOME: home },
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error(`${run.stderr}\n${run.stdout}`)
  return JSON.parse(run.stdout) as { result: unknown; records?: CanonicalRecord[] }
}

function nativeWrites(calls: string[][]) {
  return calls.filter((args) => {
    if (args[0] === 'pr') return !['view', 'list', 'status', 'diff', 'checks'].includes(args[1])
    if (args[0] === 'issue') return !['view', 'list', 'status'].includes(args[1])
    if (args[0] !== 'api') return false
    const method = args.indexOf('--method')
    if (args.includes('graphql')) return args.some((arg) => /^query=\s*mutation\b/.test(arg))
    return method !== -1 && args[method + 1] !== 'GET'
  })
}

describe('Exact abandonment without PR mutations', () => {
  it.each(
    (['selected', 'foreign'] as const).flatMap((owner) =>
      [false, true].map((historicalEpic) => ({ owner, historicalEpic })),
    ),
  )('abandons the root with a $owner bound PR (returned to leaf: $historicalEpic)', ({ owner, historicalEpic }) => {
    const { box, cwd } = fixture(owner, historicalEpic)
    const before = readSim(box)
    const { result, records } = abandonRoot(box, cwd)
    expect(result).toEqual({ kind: 'abandoned', confirmed: true })
    expect(records).toHaveLength(1)
    const record = records?.[0]
    if (record === undefined) throw new Error('Expected the authenticated abandonment record')
    expect(record).toMatchObject({
      ...ROOT,
      kind: 'operator-control',
      recordId: expect.stringMatching(/^abandon:/),
      operationId: record.recordId,
    })
    expect(record.payload).toEqual({
      control: 'abandon',
      controlId: record.recordId,
      predecessor: null,
      mandate: { scope: ROOT, recordId: 'root-mandate', kind: 'mandate' },
    })
    const after = readSim(box)
    expect(after.prs['7']?.state).toBe(before.prs['7']?.state)
    const writes = nativeWrites(after.calls.slice(before.calls.length))
    expect(writes.length).toBeGreaterThan(0)
    for (const write of writes) {
      expect(write[0]).toBe('api')
      expect(write).toContain('repos/acme/app/issues/42/comments')
      expect(write[write.indexOf('--method') + 1]).toBe('POST')
    }
  })

  it('refuses an edited mandate without writing a record or mutating the PR', () => {
    const { box, cwd } = fixture('selected', false)
    writeSim(box, (state) => {
      const comment = state.issues['42']?.comments.find((entry) => entry.body.includes('kind=mandate '))
      if (!comment) throw new Error('missing root mandate')
      comment.createdAt = '2026-01-01T00:00:00Z'
      comment.updatedAt = '2026-01-01T00:00:01Z'
    })
    const before = readSim(box)
    const { result } = abandonRoot(box, cwd)
    expect(result).toMatchObject({
      kind: 'abandoned',
      confirmed: false,
      failure: { status: 'refused' },
    })
    const after = readSim(box)
    expect(after.prs['7']?.state).toBe(before.prs['7']?.state)
    expect(nativeWrites(after.calls.slice(before.calls.length))).toEqual([])
  })
})
