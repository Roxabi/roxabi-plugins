import { BASE_NAME } from './epic-naming'

/**
 * The base from `.dev/stack.yml` `release.model`: `trunk` → the default branch
 * (`defaultBranch` is only asked then), `staging-train` → `staging`. Anything
 * else is refused: a guessed base would branch every child from the wrong place.
 */
export function baseFromStack(doc: unknown, defaultBranch: () => string): { base: string } | { error: string } {
  const release = doc && typeof doc === 'object' && 'release' in doc ? doc.release : null
  const model = release && typeof release === 'object' && 'model' in release ? release.model : undefined
  if (model === 'staging-train') return { base: 'staging' }
  if (model !== 'trunk') return { error: `release.model is ${JSON.stringify(model)}, not trunk or staging-train` }
  const base = defaultBranch().trim()
  if (!BASE_NAME.test(base) || base.includes('..'))
    return { error: `default branch ${JSON.stringify(base)} is not a branch name` }
  return { base }
}

/** One node of a commit's `statusCheckRollup`, as GitHub returns it. */
export type CheckNode =
  | {
      __typename: 'CheckRun'
      name: string
      status: string | null
      conclusion: string | null
      startedAt: string | null
      checkSuite: { workflowRun: { workflow: { name: string } } | null } | null
    }
  | { __typename: 'StatusContext'; context: string; state: string }
