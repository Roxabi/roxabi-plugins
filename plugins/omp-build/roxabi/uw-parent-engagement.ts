import {
  type GitHubOptions,
  type Result,
  readComposedWorkflowHistory,
  readUwGraph,
  type Scope,
} from '../dist/contracts.js'
import type { ParentEngagementEvidence } from '../engine/parent-insertion-engagement.ts'

export type ParentEngagementReadPort = {
  readParentEngagement(parent: Scope): Promise<Result<ParentEngagementEvidence>>
}

/** Read only the native parent graph and its own ledgers, never causal source closure. */
export function createParentEngagementReadPort(github: GitHubOptions): ParentEngagementReadPort {
  return {
    async readParentEngagement(parent) {
      const graph = await readUwGraph(parent, github)
      if (
        graph.status !== 'complete' ||
        graph.root.repository !== parent.repository ||
        graph.root.target !== parent.target
      )
        return {
          ok: false,
          diagnostics: [{ code: 'incomplete', message: 'Parent native graph is incomplete or has the wrong root' }],
        }
      const scopes = [
        ...new Map(graph.nodes.map((node) => [`${node.uw.repository}\0${node.uw.target}`, node.uw])).values(),
      ]
      const histories = await readComposedWorkflowHistory(scopes, github)
      if (!histories.ok) return { ok: false, diagnostics: histories.diagnostics }
      return { ok: true, value: { parent, graph, histories: histories.histories } }
    },
  }
}
