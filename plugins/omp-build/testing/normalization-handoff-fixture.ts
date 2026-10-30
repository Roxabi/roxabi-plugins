import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { Gh } from '../adapters/github/types.ts'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import { createInstalledObservedUwReadPort } from '../roxabi/uw-read-port.ts'

// Fictional native observations only: no mandate or authenticated workflow record.
const repository = 'fixture/widgets'
const scope = { repository, target: `${repository}#910` }
const title = 'fix: principal normalization handoff'
const body = '# Acceptance Criteria\n\n- C1 : Preserve the existing handoff.'
const time = '2026-10-21T00:00:00Z'

export function normalizationHandoffFixture() {
  const calls: string[][] = []
  const rejected: string[][] = []
  const gh: Gh = async (_cwd, args) => {
    calls.push([...args])
    const command = JSON.stringify(args)
    if (command === JSON.stringify(['repo', 'view', '--json', 'nameWithOwner']))
      return JSON.stringify({ nameWithOwner: repository })
    if (command === JSON.stringify(['api', `repos/${repository}/issues/910`])) {
      return JSON.stringify({ number: 910, state: 'open', body, user: { login: 'fixture' } })
    }
    if (command === JSON.stringify(['api', 'user', '--jq', '.login'])) return 'fixture'
    if (command === JSON.stringify(['api', `repos/${repository}/issues/910/comments?per_page=100&page=1`])) return '[]'
    if (
      command ===
      JSON.stringify(['issue', 'view', '910', '--repo', repository, '--json', 'title,body,labels,updatedAt'])
    ) {
      return JSON.stringify({ title, body, labels: [{ name: 'size:S' }], updatedAt: time })
    }
    rejected.push([...args])
    throw new Error(`Unexpected GitHub operation: ${command}`)
  }
  const graph: UwGraphObservation = {
    status: 'complete',
    root: scope,
    observedAt: time,
    nodes: [
      {
        uw: scope,
        title,
        raw: rawSource(scope.target, body, time),
        updatedAt: time,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  }
  const history = decodeHistory({
    scope,
    expectedAuthor: 'fixture',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
  return {
    gh,
    calls,
    rejected,
    graph,
    history,
    read: createInstalledObservedUwReadPort({ graph, histories: [history] }),
  }
}
