import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scopeKey } from '../../../../engine/uw-graph.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { produceNativeImplementation } from '../../../../testing/native-implementation-producer.ts'
import { serveBoundEpic } from './epic-driver-bound-fixture.ts'
import { epicNativeOperations, installEpicPlan } from './epic-driver-native.ts'
import { childNode, prNode } from './epic-driver-records.ts'
import { appendBoundReview } from './epic-driver-review-fixture.ts'
import { git, sandbox } from './epic-driver-sandbox.ts'

/** Deliver the child in the driver's own mutable GitHub and Git world. */
export async function landedEpic(
  files: Record<string, string> = {},
  siblings: readonly ReturnType<typeof childNode>[] = [],
) {
  const { principal, epic, root, state, origin } = sandbox()
  const proof = path.join(root, 'hook-ran')
  git(principal, 'config', `url.${origin}.insteadOf`, 'https://github.com/o/r.git')
  git(principal, 'remote', 'set-url', 'origin', 'https://github.com/o/r.git')
  const base = git(principal, 'rev-parse', 'HEAD')
  const branch = 'feat/2-first-child'
  git(epic, 'switch', '-q', '-c', branch)
  git(epic, 'push', '-q', 'origin', branch)
  const open = prNode(10, branch, base, { baseRefOid: base, author: { login: 'operator' } })
  serveBoundEpic(childNode(2, 'feat(x): first child', { prs: [open] }), 10, branch, true, siblings)
  const parentPlan = installEpicPlan(1, base)
  const childPlan = installEpicPlan(2, base)
  const native = await epicNativeOperations(epic, childPlan.pin)
  const scope = { repository: 'o/r', target: 'o/r#2' }
  const before = await native.operations.readUw(scope)
  const parentHistory = before.histories.find((history) => history.source.scope.target === 'o/r#1')
  if (!parentHistory) throw new Error('Missing observed parent history')
  const produced = await produceNativeImplementation({
    cwd: epic,
    ...native,
    read: before,
    scope,
    mandate: childPlan.mandate,
    parents: [parentHistory],
    startHead: base,
    command: 'bun test child.test.ts',
    output: 'PASS child',
    advance() {
      mkdirSync(path.join(epic, 'scripts'))
      writeFileSync(path.join(epic, 'scripts', 'post-merge.sh'), `#!/bin/sh\ntouch '${proof}'\n`)
      chmodSync(path.join(epic, 'scripts', 'post-merge.sh'), 0o755)
      writeFileSync(
        path.join(epic, '.dev', 'stack.yml'),
        `release:\n  model: trunk\n  post_merge:\n    - ./scripts/post-merge.sh\nworktree:\n  base: ${path.join(root, 'worktrees')}\n`,
      )
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(epic, name), text)
      git(epic, 'add', '.')
      git(epic, 'commit', '-qm', 'feat(x): first child (#2)')
      git(epic, 'push', '-q', 'origin', branch)
      const head = git(epic, 'rev-parse', 'HEAD')
      const current = prNode(10, branch, head, { baseRefOid: base, author: { login: 'operator' } })
      writeFileSync(path.join(state, 'branch-prs-2.json'), JSON.stringify([current]))
      return { head, tree: git(epic, 'rev-parse', 'HEAD^{tree}') }
    },
  })
  const candidate = git(epic, 'rev-parse', 'HEAD')
  appendBoundReview({
    number: 10,
    head: candidate,
    prefix: 'landed-child',
    blocking: false,
    author: 'operator',
    mandate: childPlan.mandate,
    issueRecords: recordsOf(produced.history),
  })
  git(principal, 'merge', '--no-ff', '-qm', 'Merge child #2', candidate)
  git(principal, 'push', '-q', 'origin', 'main')
  const merge = git(principal, 'rev-parse', 'HEAD')
  const parents = git(principal, 'rev-list', '--parents', '-n1', merge).split(' ').slice(1)
  if (parents.length !== 2 || parents[0] !== base || parents[1] !== candidate)
    throw new Error('Unexpected child merge parentage')
  const merged = prNode(10, branch, candidate, {
    state: 'MERGED',
    baseRefOid: base,
    author: { login: 'operator' },
    mergedAt: '2026-09-30T10:00:00Z',
    mergeCommit: { oid: merge, parents: { nodes: parents.map((oid) => ({ oid })) } },
  })
  writeFileSync(path.join(state, 'branch-prs-2.json'), JSON.stringify([merged]))
  const uwPath = path.join(state, 'uw-2.json')
  const uw = JSON.parse(readFileSync(uwPath, 'utf8'))
  uw.data.repository.issue.state = 'CLOSED'
  uw.data.repository.issue.stateReason = 'COMPLETED'
  writeFileSync(uwPath, JSON.stringify(uw))
  const child = childNode(2, 'feat(x): first child', { state: 'CLOSED', stateReason: 'COMPLETED', prs: [merged] })
  const epicPath = path.join(state, 'epic.json')
  const epicData = JSON.parse(readFileSync(epicPath, 'utf8'))
  epicData.data.repository.issue.subIssues.nodes = epicData.data.repository.issue.subIssues.nodes.map(
    (node: { number: number; blockedBy?: { nodes: { number: number; state: string }[] } }) => {
      if (node.number === 2) return child
      for (const blocker of node.blockedBy?.nodes ?? []) if (blocker.number === 2) blocker.state = 'CLOSED'
      return node
    },
  )
  writeFileSync(epicPath, JSON.stringify(epicData))
  const containmentPath = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentPath, 'utf8'))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = [merged]
  writeFileSync(containmentPath, JSON.stringify(containment))
  git(epic, 'fetch', '-q', 'origin')
  git(epic, 'checkout', '-q', '--detach', 'refs/remotes/origin/main')
  const delivered = await native.operations.readUw(scope)
  const completion = delivered.completion.completions.get(scopeKey(scope))
  if (delivered.observation.status !== 'complete' || completion?.state !== 'complete')
    throw new Error(`Child delivery not computed complete: ${JSON.stringify(completion)}`)
  return {
    progressRange: `${base}..${merge}`,
    merged,
    proof,
    principal,
    epic,
    parent: parentPlan.mandate,
    native,
  }
}
