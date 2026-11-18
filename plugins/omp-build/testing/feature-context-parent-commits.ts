import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { branchFor } from '../skills/feature/epic-naming.ts'
import { git } from './sandbox/sandbox-repository.ts'
import type { Box } from './sandbox/sandbox-types.ts'

const repository = 'acme/app'
const scopes = [201, 202, 203].map((number) => ({ repository, target: `${repository}#${number}` }))

export function createParentChildCommits(
  box: Box,
  checkout: string,
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
  child201Version?: string,
) {
  const initial = git(box, checkout, ['rev-parse', 'HEAD'])
  const heads: string[] = []
  const merges: string[] = []
  const bases: string[] = []
  const branches: string[] = []
  for (const [i, scope] of scopes.entries()) {
    const number = 201 + i
    const node = graph.nodes.find((item) => item.uw.target === scope.target)
    if (!node) throw new Error(`Missing child ${scope.target}`)
    const branch = branchFor({ number, title: node.title, labels: [...node.labels] })
    const base = i === 0 ? initial : merges[i - 1]
    if (!base) throw new Error('Missing preceding merge')
    git(box, checkout, ['checkout', '-q', '-b', branch, base])
    appendFileSync(
      join(checkout, 'fixture.txt'),
      i === 0 && child201Version !== undefined
        ? 'child 201: preserves the region and its timezone\n'
        : `child ${number}: preserves the region\n`,
    )
    git(box, checkout, ['add', 'fixture.txt'])
    git(box, checkout, ['commit', '-q', '-m', `feat: implement fixture (#${number})`])
    const head = git(box, checkout, ['rev-parse', 'HEAD'])
    git(box, checkout, ['push', '-q', 'origin', `${head}:refs/heads/${branch}`])
    git(box, checkout, ['checkout', '-q', '--detach', base])
    git(box, checkout, ['merge', '--no-ff', '-q', '-m', `merge child ${number}`, head])
    const merge = git(box, checkout, ['rev-parse', 'HEAD'])
    git(box, checkout, ['push', '-q', 'origin', `${merge}:refs/heads/main`])
    bases.push(base)
    heads.push(head)
    merges.push(merge)
    branches.push(branch)
  }
  git(box, checkout, ['fetch', '-q', 'origin', 'main'])
  return { heads, merges, bases, branches }
}
