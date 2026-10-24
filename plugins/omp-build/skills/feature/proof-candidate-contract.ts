import type { TreeEntry } from './proof-tree'

/** A declaration committed at the established base tip or candidate sha. */
export type Declared = { at: string; entry: TreeEntry }

/** The committed Semctx configuration under which the producer runs. */
export type SemctxConfig = { source: 'committed'; path: string; text: string; sha256: string }

export type CandidateFacts = {
  /** `git rev-parse --show-toplevel` of the caller's cwd, lossless. */
  toplevel: string
  candidate: string
  /** The selected PR base branch and its freshly established, immutable commit. */
  base: string
  baseTip: string
  semctx: 'absent' | 'configured'
  /** Set exactly when Semctx is configured. */
  config: SemctxConfig | null
  /** Every `.semctx/semantic/changes/**.sem` committed at the candidate. */
  changeFiles: string[]
  /** `.dev/stack.yml` as the base and the candidate commit it. */
  stacks: Declared[]
  /** The assertledger configuration declarations the base and the candidate commit. */
  adapters: Declared[]
}
