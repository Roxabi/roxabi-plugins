import { decodeHistory } from '../../../../contracts.ts'
import { epicFixtureGraph, issueComments, recordHistory } from './epic-driver-records.ts'

/** Read histories for the complete observed child graph, including unmandated siblings. */
export function childGraphHistories() {
  const scope = { repository: 'o/r', target: 'o/r#2' }
  const graph = epicFixtureGraph(scope)
  const histories = graph.nodes.map((node) => {
    const match = /^o\/r#([1-9]\d*)$/.exec(node.uw.target)
    if (node.uw.repository !== 'o/r' || match === null)
      throw new Error(`Unexpected review history scope ${node.uw.target}`)
    const number = Number(match[1])
    return decodeHistory(recordHistory(number, issueComments(number)))
  })
  const origin = histories.find((history) => history.source.scope.target === scope.target)
  if (!origin) throw new Error('Missing observed child history')
  return { graph, origin, histories, external: histories.filter((history) => history !== origin) }
}
