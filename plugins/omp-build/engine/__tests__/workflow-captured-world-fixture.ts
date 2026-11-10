import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import type { UwRead } from '../../roxabi/uw-contract.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { withUnplannedInheritedWorld } from '../../testing/native-unplanned-inherited-world.ts'
import { nestedDeliverySpecifications } from '../../testing/nested-delivery-world.ts'
import { operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import type { PlanOutput, PlanReview } from '../workflow-output-schema.ts'
export const output: PlanOutput = {
  steps: [
    {
      id: 'leaf-plan',
      change: 'Deliver the assigned work',
      doneWhen: 'Deliver the assigned work',
      criterionIds: ['C1'],
      evidence: 'Exercise the assigned work',
      paths: ['fixture.txt'],
    },
  ],
  resolutions: [],
}
export const clear: PlanReview = { outcome: 'clear', blockers: [] }

export function evidence(
  read: UwRead,
  leaf: { repository: string; target: string },
  parents: readonly { repository: string; target: string }[],
) {
  if (read.observation.status !== 'complete')
    throw new Error(`Expected complete native observation: ${JSON.stringify(read.observation)}`)
  const find = (scope: typeof leaf) =>
    read.histories.find(
      (history) => history.source.scope.repository === scope.repository && history.source.scope.target === scope.target,
    )
  const issue = find(leaf)
  if (!issue) throw new Error('Leaf native history unavailable')
  const parentHistories = parents.map((scope) => {
    const item = find(scope)
    if (!item) throw new Error(`Native ancestor missing: ${scope.target}`)
    return item
  })
  return {
    issue,
    parents: parentHistories,
    pullRequest: null,
    causal: {
      histories: read.observation.histories,
      catalogues: read.observation.catalogues,
      observation: read.observation,
    },
  }
}

export async function inWorld<T>(
  use: (arg: {
    world: Parameters<Parameters<typeof withUnplannedInheritedWorld>[1]>[0]['world']
    scenario: Parameters<Parameters<typeof withUnplannedInheritedWorld>[1]>[0]['scenario']
    git: { repository: string; commit: string; tree: string }
    next: { commit: string; tree: string; cwd: string }
    confirmations: () => number
  }) => Promise<T>,
) {
  const git = nativeImplementationGit(202)
  const worktree = mkdtempSync(join(tmpdir(), 'omp-captured-worktree-'))
  try {
    let confirmations = 0
    const operator = createOperatorConfirmation({
      ...operatorRootContext(worktree, { getArtifactsDir: () => worktree }),
      hasUI: true,
      mode: 'tui',
      ui: operatorDialogUi(async () => {
        confirmations += 1
        return 'confirm'
      }),
    } as unknown as ExtensionContext)
    const base = git.p0
    git.checkout(base)
    const parentCheckout = await git.parent(nestedDeliverySpecifications().root)
    execFileSync('git', ['-C', parentCheckout.cwd, 'switch', '--quiet', '-c', 'feature/202-leaf', base])
    const parent = git.tree(base)
    const head = git.heads[0]
    if (!head) throw new Error('Independent implementation commit is missing')
    const headTree = git.tree(head)
    return await withUnplannedInheritedWorld(
      {
        cwd: parentCheckout.cwd,
        operator,
        checkout: { branch: 'feature/202-leaf', head: base, base: 'main', baseTip: base, remoteTip: base },
        commits: [
          { sha: base, parents: [], tree: parent, subject: 'fixture base', paths: [], config: null },
          {
            sha: head,
            parents: [base],
            tree: headTree,
            subject: 'feat: implement fixture (#202)',
            paths: ['fixture.txt'],
            config: null,
          },
        ],
        comparisons: [
          { base, head: base, status: 'identical', commits: [] },
          { base, head, status: 'ahead', commits: [head] },
        ],
        diffs: [{ base, head, bytes: git.diff(base, head) }],
      },
      ({ world, scenario }) =>
        use({
          world,
          scenario,
          git: { repository: scenario.leaf.repository, commit: base, tree: parent },
          next: { commit: head, tree: headTree, cwd: parentCheckout.cwd },
          confirmations: () => confirmations,
        }),
    )
  } finally {
    rmSync(worktree, { recursive: true, force: true })
    git.cleanup()
  }
}
