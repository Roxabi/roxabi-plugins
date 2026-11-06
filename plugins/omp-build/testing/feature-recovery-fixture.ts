import { rmSync } from 'node:fs'
import path from 'node:path'
import { actionInputDigest } from '../engine/action-input.ts'
import { buildRecord } from '../engine/record-construction.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import { nativeImplementationWorld } from './native-implementation-world.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'
import { eligiblePlan } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

export const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const BRANCH = 'feat/42-save'
export const OBSERVED_INCOMPLETE_NATIVE_TERMINAL = {
  index: 0,
  id: 'R-workflow-implement',
  agent: 'R-workflow-implement',
  exitCode: 1,
  structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
}

const FEATURE_SPEC = nativeFeatureSpec(SCOPE, 'preserves the region')
const BODY = FEATURE_SPEC.body
const { featureMandate, framedBodies, implementStart } = roxabiWorkflowFixtures()

let roots: string[] = []

export function cleanupFeatureRecoveryRoots(): void {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
}

export function trackFeatureRecoveryRoot(root: string): void {
  roots.push(root)
}

function createFeatureFixture(
  records: 'plan' | 'start' | 'confirmed-implementation',
  options: { malformedDisarmPr?: boolean } = {},
): { box: Box; checkout: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'README.md': 'base\n' },
    branches: [
      {
        name: BRANCH,
        from: 'main',
        commits:
          records === 'confirmed-implementation'
            ? [{ message: 'feat: preserve region (#42)', files: { 'src/save.ts': 'export const save = true\n' } }]
            : [],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region', labels: ['size:S'] }],
    prs: options.malformedDisarmPr
      ? [{ number: 9, branch: BRANCH, title: 'unreadable pause gate', body: '', closes: [] }]
      : [],
  })
  trackFeatureRecoveryRoot(box.root)
  git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const checkout = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', checkout, BRANCH])
  const mandate = featureMandate(SCOPE, {
    branch: BRANCH,
    body: BODY,
    ownSpec: FEATURE_SPEC.ownSpec,
    lineageHead: box.sha.main,
  })
  const accepted =
    records === 'plan' || records === 'confirmed-implementation'
      ? eligiblePlan(mandate, [roxabiWorkflowFixtures().historyFrom([mandate])])
      : [mandate, implementStart(mandate)]
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.body = BODY
    issue.comments.push(...framedBodies(accepted, 'operator').map((body) => ({ author: 'operator', body })))
  })
  if (options.malformedDisarmPr) {
    writeSim(box, (state) => {
      const pull = state.prs['9']
      if (!pull) throw new Error('missing disarm pull request')
      Object.assign(pull, { labels: [1] })
    })
  }
  return { box, checkout }
}

export function featureFixture(records: 'plan' | 'start', options: { malformedDisarmPr?: boolean } = {}) {
  return createFeatureFixture(records, options)
}

/** Produce the committed implementation through the real START/capture/admission publisher. */
export async function confirmedFeatureFixture(): Promise<{ box: Box; checkout: string }> {
  const { box, checkout } = createFeatureFixture('confirmed-implementation')
  const startHead = box.sha.main
  const head = box.sha[BRANCH]
  if (!startHead || !head) throw new Error('confirmed implementation fixture missing Git boundaries')
  const mandate = featureMandate(SCOPE, {
    branch: BRANCH,
    body: BODY,
    ownSpec: FEATURE_SPEC.ownSpec,
    lineageHead: startHead,
  })
  const plan = eligiblePlan(mandate, [roxabiWorkflowFixtures().historyFrom([mandate])]).map((record) => {
    if (record.kind !== 'action-receipt') return record
    const previous = record.payload.inputs
    const manifest = {
      ...previous.manifest,
      code: { repository: SCOPE.repository, base: startHead, head: startHead, referenceCommit: startHead },
    }
    const built = buildRecord({
      ...record,
      payload: { ...record.payload, inputs: { ...previous, manifest, fingerprint: actionInputDigest(manifest) } },
    })
    if (!built.ok) throw new Error(`Invalid committed fixture plan ${JSON.stringify(built.diagnostics)}`)
    return built.value
  })
  const observe = (sha: string) => {
    const [actual, ...parents] = git(box, checkout, ['rev-list', '--parents', '-n1', sha]).split(' ')
    if (actual !== sha) throw new Error('Wrong fixture commit')
    return {
      sha,
      parents,
      tree: git(box, checkout, ['rev-parse', `${sha}^{tree}`]),
      subject: git(box, checkout, ['show', '-s', '--format=%s', sha]),
      paths: git(box, checkout, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean),
      config: git(box, checkout, ['show', `${sha}:.dev/stack.yml`]),
    }
  }
  const graph = graphFromSimulatedIssues(SCOPE, [
    {
      number: 42,
      title: 'feat: preserve region',
      body: BODY,
      updatedAt: '2026-10-27T12:00:00Z',
      state: 'OPEN',
      stateReason: null,
      labels: ['size:S'],
      subIssues: [],
      blockedBy: [],
    },
  ])
  const produced = await nativeImplementationWorld({
    graph,
    histories: [roxabiWorkflowFixtures().historyFrom(plan)],
    scope: SCOPE,
    mandate,
    startHead,
    head,
    branch: BRANCH,
    command: 'bun test region.test.ts',
    output: 'PASS region',
    author: 'operator',
    commits: [observe(startHead), observe(head)],
    baseTip: startHead,
    remoteTipBefore: startHead,
    remoteTipAfter: head,
    pullRequestsBefore: [],
    pullRequestsAfter: [],
    comparisons: [],
  })
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('missing feature issue')
    issue.comments = framedBodies(produced.records, 'operator').map((body) => ({ author: 'operator', body }))
  })
  return { box, checkout }
}
