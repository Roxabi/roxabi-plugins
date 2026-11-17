import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { nativeFeatureSpec } from './feature-review-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox, writeSim } from './sandbox/sandbox-repository.ts'

// Run inside the copied current-algorithm package with its sealed synthetic version.
const repository = 'acme/app'
const parent = { repository, target: `${repository}#200` }
const children = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))
const workflow = roxabiWorkflowFixtures()
const original = nativeFeatureSpec(parent, 'preserves the region')
const proposed = nativeFeatureSpec(parent, 'preserves the region and its timezone')
const childSpecs = children.map((scope) => nativeFeatureSpec(scope, 'preserves the region'))
const grants = children.map((scope, index) => {
  const spec = childSpecs[index]
  if (!spec) throw new Error(`Missing child specification ${scope.target}`)
  return { scope, snapshot: spec.ownSpec.snapshot, specVersion: spec.ownSpec.version, tier: 'S' as const }
})
const mandate = workflow.epicMandate(parent, grants, {
  recordId: 'parent-mandate',
  ownSpec: original.ownSpec,
  body: original.body,
})
const box = sandbox({
  base: { '.dev/stack.yml': 'package_manager: bun\nrelease:\n  model: trunk\n', 'fixture.txt': 'base\n' },
  branches: [],
  issues: [200, 201, 202, 203].map((number) => ({
    number,
    title: number === 200 ? 'Parent' : `${repository}#${number}`,
    labels: ['size:S'],
  })),
  prs: [],
})
git(box, box.root, ['--git-dir', box.origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
git(box, box.principal, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
const worktreeRoot = join(box.root, 'context-worktrees')
const checkout = join(worktreeRoot, 'app', 'parents', 'acme-200')
mkdirSync(join(worktreeRoot, 'app', 'parents'), { recursive: true })
const main = box.sha.main
if (!main) throw new Error('Missing main commit')
git(box, box.principal, ['worktree', 'add', '--detach', '-q', checkout, main])
const date = '2026-10-21T12:00:00Z'
writeSim(box, (state) => {
  const issue = state.issues['200']
  if (!issue) throw new Error('Missing parent issue')
  issue.body = original.body
  issue.subIssues = [201, 202, 203]
  issue.comments.push(
    ...workflow
      .framedBodies([mandate], 'operator')
      .map((body) => ({ author: 'operator', body, createdAt: date, updatedAt: date })),
  )
  for (const [index, scope] of children.entries()) {
    const child = state.issues[String(201 + index)]
    const spec = childSpecs[index]
    if (!child || !spec) throw new Error(`Missing child ${scope.target}`)
    child.body = spec.body
    child.comments.push(
      ...workflow
        .framedBodies([workflow.identityAllocation(scope)], 'operator')
        .map((body) => ({ author: 'operator', body, createdAt: date, updatedAt: date })),
    )
  }
})
process.stdout.write(
  JSON.stringify({
    box,
    checkout,
    worktreeRoot,
    original: original.ownSpec.version,
    proposed: proposed.body,
    proposedVersion: proposed.ownSpec.version,
  }),
)
