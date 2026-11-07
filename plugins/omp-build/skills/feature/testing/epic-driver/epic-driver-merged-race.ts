import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { landedEpic } from './epic-driver-landed-fixture.ts'
import { servePr } from './epic-driver-records.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

/** Present the real completed delivery first as stale OPEN and then as its actual merge. */
export async function landedEpicDuringDisarm(autoMerge = false) {
  const world = await landedEpic()
  const { state } = sandboxOf()
  const merged = world.merged
  const open = {
    ...merged,
    state: 'OPEN',
    mergedAt: null,
    mergeCommit: null,
    labels: { nodes: [{ name: 'reviewed' }], pageInfo: { hasNextPage: false } },
    autoMergeRequest: autoMerge ? { enabledAt: '2026-09-30T09:00:00Z' } : null,
  }
  const branchFile = path.join(state, 'branch-prs-2.json')
  writeFileSync(`${branchFile}.after-edit`, readFileSync(branchFile))
  writeFileSync(branchFile, JSON.stringify([open]))
  const uwFile = path.join(state, 'uw-2.json')
  const uw = JSON.parse(readFileSync(uwFile, 'utf8'))
  writeFileSync(`${uwFile}.after-edit`, JSON.stringify(uw))
  uw.data.repository.issue.state = 'OPEN'
  uw.data.repository.issue.stateReason = null
  writeFileSync(uwFile, JSON.stringify(uw))
  const containmentFile = path.join(state, 'containment-2.json')
  const containment = JSON.parse(readFileSync(containmentFile, 'utf8'))
  writeFileSync(`${containmentFile}.after-edit`, JSON.stringify(containment))
  containment.data.repository.issue.closedByPullRequestsReferences.nodes = [open]
  writeFileSync(containmentFile, JSON.stringify(containment))
  const epicFile = path.join(state, 'epic.json')
  const initial = JSON.parse(readFileSync(epicFile, 'utf8'))
  initial.data.repository.issue.subIssues.nodes[0].state = 'OPEN'
  initial.data.repository.issue.subIssues.nodes[0].stateReason = null
  initial.data.repository.issue.subIssues.nodes[0].closedByPullRequestsReferences.nodes = [open]
  const readsPath = path.join(state, 'reads')
  const priorReads = existsSync(readsPath) ? Number(readFileSync(readsPath, 'utf8')) : 0
  if (!Number.isSafeInteger(priorReads) || priorReads < 0) throw new Error('Invalid sandbox read counter')
  writeFileSync(`${epicFile}.${priorReads + 1}`, JSON.stringify(initial))
  servePr(10, { state: 'OPEN', labels: ['reviewed'], autoMerge })
  const prFile = path.join(state, 'pr', '10.json')
  writeFileSync(
    prFile,
    JSON.stringify({
      ...JSON.parse(readFileSync(prFile, 'utf8')),
      headRefName: merged.headRefName,
      baseRefName: merged.baseRefName,
    }),
  )
  writeFileSync(path.join(state, 'pr', '10.merge-on-edit.json'), JSON.stringify(merged))
  return { ...world, state, priorReads }
}
