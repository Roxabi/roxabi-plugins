import { diagnostic } from './record-diagnostics.ts'
import type { WorkflowFacts } from './workflow-reconstruction-types.ts'

export function sessionEvidence(facts: WorkflowFacts) {
  const path = facts.preparedWorktree ?? ''
  return [diagnostic('session-cwd', 'Session cwd is not the prepared worktree', { path, instruction: `/move ${path}` })]
}

export function sessionReady(facts: WorkflowFacts): boolean {
  return facts.sessionCwd !== null && facts.preparedWorktree !== null && facts.sessionCwd === facts.preparedWorktree
}
