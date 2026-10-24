import type { MigrateLabel } from './feature-init-triage'
export type Gh = (args: string[]) => string | null
export type GitRemoteUrl = (remote: string) => string | null
export type ParseYaml = (text: string) => unknown

/** `ok`, or why the repository's labels are not known. */
export type LabelsState = 'ok' | 'gh-failed' | 'no-origin' | 'non-github'
/** Whether a lefthook git hook runs semctx, or why that cannot be told. */
export type HooksState = 'present' | 'absent' | 'unreadable' | 'extends' | `lefthook.${'toml' | 'json' | 'jsonc'}`

export type Facts = {
  hasTracker: boolean
  labels: string[]
  labelsState: LabelsState
  legacyLabels: string[]
  hasSemctx: boolean
  hooks: HooksState
  hasWorkingEmptyJob: boolean
  activeContracts: number
  hasAssertledger: boolean
  vitest: boolean
  hasCcc: boolean
  hasCodegraph: boolean
  mergeOnGreen: boolean
  hasLanding: boolean
  landingHidesChecks: boolean
  gates: string[]
  hasWorktree: boolean
  hasPostMerge: boolean
  hasReleaseModel: boolean
  cccConsent: boolean
  codegraphConsent: boolean
}

export type ReadFactsOpts = { gh?: Gh; gitRemoteUrl?: GitRemoteUrl; migrateLabel?: MigrateLabel; parseYaml?: ParseYaml }
export type StackAddition = { key: 'commands.test' | 'worktree' | 'landing'; text: string; source: string }
export type StackProposal = {
  additions: StackAddition[]
  conflicts: string[]
  refusal: string | null
  before: string | null
  after: string | null
}
export type CommandEvidence = { command: string; source: string }
