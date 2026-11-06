import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest, buildRecord } from '../dist/contracts.js'
import { specDigest } from '../engine/record-digests.ts'
import type { Scope } from '../engine/record-values.ts'
import { canonicalSpec } from '../engine/uw-spec.ts'
import { SPEC_CONTENT_FORMAT } from '../engine/uw-spec-schema.ts'
import { graphFromSimulatedIssues } from './criterion-dispositions.ts'
import { nativeImplementationWorld } from './native-implementation-world.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'
import { eligiblePlan } from './workflow-decision-cases/support/workflow-decision-fixtures.ts'

export const REVIEW_SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
export const REVIEW_BRANCH = 'feat/42-save'

export function nativeFeatureSpec(scope: Scope, criterion: string) {
  const canonical = canonicalSpec({
    format: SPEC_CONTENT_FORMAT,
    criteria: [{ id: 'C1', statement: criterion }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(canonical.diagnostics.map((item) => item.code).join(','))
  const body = renderIssueSpecBody(canonical.value)
  return {
    body,
    ownSpec: roxabiWorkflowFixtures().ownSpecFromSnapshot(scope, {
      spec: canonical.value,
      raw: { reference: scope.target, body, bodySha256: specDigest(body), lastEditedAt: '2026-10-21T12:00:00Z' },
    }),
  }
}

const REVIEW_TIER = 'F-lite' as const
const REVIEW_SPEC = nativeFeatureSpec(REVIEW_SCOPE, 'preserves the region')
export const REVIEW_BODY = REVIEW_SPEC.body
const { featureMandate, framedBodies, historyFrom, workflowBinding } = roxabiWorkflowFixtures()

export function arrangeReviewFixture(): { box: Box; cwd: string } {
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'README.md': 'base\n' },
    branches: [
      {
        name: REVIEW_BRANCH,
        from: 'main',
        commits: [{ message: 'feat: preserve region (#42)', files: { 'src/save.ts': 'export const save = true\n' } }],
      },
    ],
    issues: [{ number: 42, title: 'feat: preserve region', labels: [`size:${REVIEW_TIER}`] }],
    prs: [{ number: 7, branch: REVIEW_BRANCH, title: 'feat: preserve region', body: 'Closes #42', closes: [42] }],
  })
  git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const cwd = path.join(box.root, 'feature')
  git(box, box.principal, ['worktree', 'add', '-q', cwd, REVIEW_BRANCH])
  return { box, cwd }
}

export async function seedReviewFixture(box: Box, cwd: string): Promise<void> {
  const head = box.sha[REVIEW_BRANCH]
  if (head === undefined) throw new Error('review-fixture-head-missing')
  const startHead = box.sha.main
  if (startHead === undefined) throw new Error('review-fixture-base-missing')
  const mandate = featureMandate(REVIEW_SCOPE, {
    branch: REVIEW_BRANCH,
    body: REVIEW_BODY,
    ownSpec: REVIEW_SPEC.ownSpec,
    lineageHead: startHead,
    tier: REVIEW_TIER,
  })
  const toolingCommit = execFileSync(
    'gh',
    ['variable', 'get', 'OMP_BUILD_TOOLING_SHA', '--repo', 'Roxabi/roxabi-plugins'],
    {
      cwd,
      env: box.env,
      encoding: 'utf8',
    },
  ).trim()
  const fileDigests = new Map<string, string>()
  const plan = eligiblePlan(mandate, [historyFrom([mandate])]).map((record) => {
    if (record.kind !== 'action-receipt') return record
    const prior = record.payload.inputs
    const plugin = prior.manifest.plugin
    const manifest = {
      ...prior.manifest,
      code: { repository: REVIEW_SCOPE.repository, base: startHead, head: startHead, referenceCommit: startHead },
      plugin: {
        ...plugin,
        commit: toolingCommit,
        files: plugin.files.map((file) => {
          let digest = fileDigests.get(file.path)
          if (digest === undefined) {
            const bytes = execFileSync(
              'git',
              ['-C', path.join(box.root, 'omp-tooling.git'), 'show', `${toolingCommit}:${file.path}`],
              {
                env: box.env,
              },
            )
            digest = createHash('sha256').update(bytes).digest('hex')
            fileDigests.set(file.path, digest)
          }
          return { ...file, commit: toolingCommit, digest }
        }),
      },
    }
    const updated = buildRecord({
      ...record,
      payload: { ...record.payload, inputs: { ...prior, manifest, fingerprint: actionInputDigest(manifest) } },
    })
    if (!updated.ok) throw new Error(JSON.stringify(updated.diagnostics))
    return updated.value
  })
  const graph = graphFromSimulatedIssues(REVIEW_SCOPE, [
    {
      number: 42,
      title: 'feat: preserve region',
      body: REVIEW_BODY,
      updatedAt: '2026-10-27T12:00:00Z',
      state: 'OPEN',
      stateReason: null,
      labels: [`size:${REVIEW_TIER}`],
      subIssues: [],
      blockedBy: [],
    },
  ])
  const readGit = (args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { env: box.env, encoding: 'utf8' }).trim()
  const commit = (sha: string) => {
    const [actual, ...parents] = readGit(['rev-list', '--parents', '-n1', sha]).split(' ')
    if (actual !== sha) throw new Error('Git returned the wrong fixture commit')
    return {
      sha,
      parents,
      tree: readGit(['rev-parse', `${sha}^{tree}`]),
      subject: readGit(['show', '-s', '--format=%s', sha]),
      paths: readGit(['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split('\n').filter(Boolean),
      config: readGit(['show', `${sha}:.dev/stack.yml`]),
    }
  }
  const pullScope = { repository: 'acme/app', target: 'acme/app#7' }
  const pullHistory = decodeHistory({
    scope: pullScope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
  const rangeCommits = readGit(['rev-list', '--reverse', `${startHead}..${head}`])
    .split('\n')
    .filter(Boolean)
  const records = (
    await nativeImplementationWorld({
      graph,
      histories: [historyFrom(plan), pullHistory],
      scope: REVIEW_SCOPE,
      mandate,
      startHead,
      head,
      branch: REVIEW_BRANCH,
      command: 'bun test region.test.ts',
      output: 'PASS region',
      author: 'operator',
      commits: [commit(startHead), ...rangeCommits.map(commit)],
      baseTip: startHead,
      remoteTipBefore: startHead,
      remoteTipAfter: head,
      pullRequestsBefore: [
        {
          scope: pullScope,
          branch: REVIEW_BRANCH,
          base: 'main',
          head: startHead,
          baseTip: startHead,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      pullRequestsAfter: [
        {
          scope: pullScope,
          branch: REVIEW_BRANCH,
          base: 'main',
          head,
          baseTip: startHead,
          state: 'OPEN',
          mergeCommit: null,
          author: 'operator',
        },
      ],
      comparisons: [
        { base: startHead, head: startHead, status: 'identical', commits: [] },
        { base: startHead, head, status: rangeCommits.length ? 'ahead' : 'identical', commits: rangeCommits },
      ],
    })
  ).records
  const binding = workflowBinding({ repository: 'acme/app', target: 'acme/app#7' }, mandate, REVIEW_BRANCH, 'main')
  writeSim(box, (state) => {
    const issue = state.issues['42']
    const pull = state.prs['7']
    if (issue === undefined || pull === undefined) throw new Error('review-fixture-scope-missing')
    issue.body = REVIEW_BODY
    issue.comments.push(...framedBodies(records, 'operator').map((body) => ({ author: 'operator', body })))
    pull.comments.push(
      ...framedBodies([binding], 'operator', [historyFrom(records)]).map((body) => ({ author: 'operator', body })),
    )
  })
}
