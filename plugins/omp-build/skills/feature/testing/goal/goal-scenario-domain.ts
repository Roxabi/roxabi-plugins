export const RUN_A = 'run000a1'
export const RUN_B = 'run000b2'
export const EPIC = 1
export const A = 2
export const B = 3
export const C = 4
export const BRANCH_A = 'feat/2-child-a'
export const BRANCH_B = 'feat/3-child-b'
export const BRANCH_C = 'feat/4-child-c'
export const CHILD_BODY = '## Acceptance criteria\n\n- [ ] lands\n'
export const EPIC_BODY = '## Acceptance criteria\n\n- [ ] delivered\n'

export type Comment = { author: string; body: string }
export type Check = { name: string; status: string; conclusion: string; workflowName: string; startedAt: string }
export type Pull = {
  number: number
  state: string
  headRefName: string
  headRefOid: string
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  mergeCommit: { oid: string; parents: string[] } | null
  closes: number[]
}
export type Issue = { number: number; state: string; comments: Comment[]; subIssues: number[] }
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
