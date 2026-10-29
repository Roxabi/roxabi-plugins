import { canonicalSpec, renderIssueSpecBody } from '../../../../contracts.ts'

function strictSpecBody(statement: string): string {
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok)
    throw new Error(`fixture Spec rejected: ${canonical.diagnostics.map((entry) => entry.code).join(',')}`)
  return renderIssueSpecBody(canonical.value, { complexity: 1 })
}

export const RUN_A = 'run000a1'
export const RUN_B = 'run000b2'
export const EPIC = 1
export const A = 2
export const B = 3
export const C = 4
export const BRANCH_A = 'feat/2-child-a'
export const BRANCH_B = 'feat/3-child-b'
export const BRANCH_C = 'feat/4-child-c'
export const CHILD_BODY = strictSpecBody('lands')
export const EPIC_BODY = strictSpecBody('delivered')

export type Comment = { author: string; body: string; id?: number; createdAt?: string; updatedAt?: string }
export type Check = { name: string; status: string; conclusion: string; workflowName: string; startedAt: string }
export type Pull = {
  comments: Comment[]
  number: number
  state: string
  headRefName: string
  headRefOid: string
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  mergeCommit: { oid: string; parents: string[] } | null
  closes: number[]
}
export type Issue = {
  number: number
  state: string
  stateReason?: string | null
  body: string
  comments: Comment[]
  subIssues: number[]
}
export type SimState = {
  issues: Record<string, Issue>
  prs: Record<string, Pull>
  checks: Record<string, Check[]>
  calls: string[][]
}
export type Box = { root: string; origin: string; epic: string; stateFile: string; env: NodeJS.ProcessEnv }
export type DriverNext = {
  step: { action: string; ticket?: number; branch?: string; range?: string; stop?: string; stage?: string }
  reconciled: { ticket: number; pr: number; disarmed: string }[]
  cleaned: string[]
}
