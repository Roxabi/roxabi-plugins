import { createHash } from 'node:crypto'
import { CONFIG, errorMessage, type Git, ignoredSemctxState, isMap, type Refusal, refuse } from './proof-base'
import type { CandidateFacts } from './proof-candidate'
import { blob, type TreeEntry } from './proof-tree'

function semctxEntry(entry: TreeEntry): boolean {
  return entry.path === '.semctx' || entry.path.startsWith('.semctx/')
}

function workingSemctxRefusal(entries: TreeEntry[], candidate: string): Refusal | null {
  const working = entries.filter(
    (entry) => entry.path.startsWith('.semctx/working/') && entry.path !== '.semctx/working/.gitkeep',
  )
  return working.length
    ? refuse(
        'semctx',
        'ambiguous',
        `candidate ${candidate} commits Semctx working state (${working.map((entry) => entry.path).join(', ')}); it overrides committed contracts — remove it from the branch`,
      )
    : null
}

async function ignoredStateRefusal(
  entries: TreeEntry[],
  baseEntries: TreeEntry[],
  git: Git,
  toplevel: string,
): Promise<Refusal | null> {
  if (entries.length || baseEntries.some(semctxEntry)) return null
  const ignored = await ignoredSemctxState(git, toplevel)
  if (ignored instanceof Error) return refuse('semctx', 'unreadable', ignored.message)
  return ignored
    ? refuse(
        'semctx',
        'ambiguous',
        `ignored local Semctx state at ${JSON.stringify(ignored)} cannot establish portable proof — commit the configuration or remove the state`,
      )
    : null
}

function changedConfigRefusal(
  baseConfig: TreeEntry | undefined,
  committed: TreeEntry | undefined,
  candidate: string,
  baseRef: string,
): Refusal | null {
  if (!baseConfig || committed?.oid === baseConfig.oid) return null
  return refuse(
    'semctx',
    'ambiguous',
    `candidate ${candidate} ${committed ? 'changes' : 'deletes'} the ${CONFIG} ${baseRef} commits: a PR is judged under the base's Semctx policy, never its own — a configuration change lands outside landPr`,
  )
}

async function committedConfigFacts(
  committed: TreeEntry | undefined,
  git: Git,
  toplevel: string,
  candidate: string,
): Promise<Pick<CandidateFacts, 'semctx' | 'config'> | Refusal | null> {
  if (!committed) return null
  try {
    const text = await blob(git, toplevel, committed)
    if (!isMap(JSON.parse(text))) throw new Error('not a JSON object')
    return {
      semctx: 'configured',
      config: { source: 'committed', path: CONFIG, text, sha256: createHash('sha256').update(text).digest('hex') },
    }
  } catch (error) {
    return refuse(
      'semctx',
      'unreadable',
      `${CONFIG} at ${candidate} is malformed or unreadable: ${errorMessage(error)}`,
    )
  }
}

function stateWithoutConfigRefusal(
  entries: TreeEntry[],
  baseEntries: TreeEntry[],
  candidate: string,
  baseRef: string,
): Refusal | null {
  const committedState = entries[0] ?? baseEntries.find(semctxEntry)
  if (!committedState) return null
  const where = entries.length ? `candidate ${candidate}` : `${baseRef} (the candidate removes it)`
  return refuse(
    'semctx',
    'ambiguous',
    `${where} commits .semctx (${committedState.path}) without a regular ${CONFIG}: ignored local configuration cannot establish portable proof — commit the configuration or remove the Semctx state`,
  )
}

export async function semctxFacts(
  git: Git,
  toplevel: string,
  candidate: string,
  baseRef: string,
  entries: TreeEntry[],
  baseEntries: TreeEntry[],
): Promise<Pick<CandidateFacts, 'semctx' | 'config'> | Refusal> {
  const semctxEntries = entries.filter(semctxEntry)
  const working = workingSemctxRefusal(semctxEntries, candidate)
  if (working) return working
  const ignored = await ignoredStateRefusal(semctxEntries, baseEntries, git, toplevel)
  if (ignored) return ignored
  const baseConfig = baseEntries.find((entry) => entry.path === CONFIG)
  const committed = entries.find((entry) => entry.path === CONFIG)
  const changed = changedConfigRefusal(baseConfig, committed, candidate, baseRef)
  if (changed) return changed
  const configured = await committedConfigFacts(committed, git, toplevel, candidate)
  if (configured) return configured
  return stateWithoutConfigRefusal(semctxEntries, baseEntries, candidate, baseRef) ?? { semctx: 'absent', config: null }
}
