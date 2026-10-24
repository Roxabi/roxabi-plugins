import { isAbsolute } from 'node:path'
import {
  ASSERTLEDGER_CONFIG,
  CHANGES_DIR,
  type Gh,
  type Git,
  gitError,
  oneLine,
  type Refusal,
  refuse,
  repositoryOf,
  SHA,
  STACK,
} from './proof-base'
import type { CandidateFacts, Declared } from './proof-candidate-contract'
import { semctxFacts } from './proof-candidate-semctx'
import { declarations, type TreeEntry } from './proof-tree'

/**
 * Establish the selected base: resolve origin's explicit URL through gh and
 * require the selected repository before fetching it. GitHub's `baseRefOid` is
 * recorded when the PR is opened, its head pushed or its base retargeted, and does
 * not follow the branch: the fetch, never that field, is the selected tip, and a
 * later fetch that differs from it is a moved base.
 */
export async function refreshSelectedBase(
  cwd: string,
  base: string,
  git: Git,
  gh: Gh,
): Promise<{ ok: true; tip: string } | Refusal> {
  if (!base || base.startsWith('-'))
    return refuse('candidate', 'unreadable', `PR base ${JSON.stringify(base)} is not a branch name`)
  const remote = await git(cwd, ['remote', 'get-url', 'origin'])
  const url = oneLine(remote.stdout)
  if (remote.code !== 0 || !url || url.startsWith('-'))
    return refuse('candidate', 'unreadable', 'origin has no readable repository URL')
  let selected: string
  let source: string
  try {
    selected = await repositoryOf(gh, cwd)
    source = await repositoryOf(gh, cwd, url)
  } catch {
    return refuse('candidate', 'unreadable', 'gh cannot resolve origin and selected repository identities')
  }
  if (source !== selected)
    return refuse('candidate', 'unbound', `origin repository ${source} conflicts with selected repository ${selected}`)
  // Keep the verified URL, not the mutable remote name, as this fetch's source.
  const fetchArgs = ['fetch', '--quiet', '--no-tags', url, `+refs/heads/${base}:refs/remotes/origin/${base}`]
  const fetched = await git(cwd, fetchArgs)
  if (fetched.code !== 0)
    return refuse(
      'candidate',
      'unreadable',
      `verified origin base ${JSON.stringify(base)} fetch failed (${fetched.code})`,
    )
  const args = ['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`]
  const read = await git(cwd, args)
  const tip = oneLine(read.stdout)
  if (read.code !== 0 || !SHA.test(tip)) return refuse('candidate', 'unreadable', gitError(args, read))
  return { ok: true, tip }
}

type CandidateCore = Omit<CandidateFacts, 'semctx' | 'config'>

function candidateInput(candidate: string, base: string | undefined, baseTip: string): { base: string } | Refusal {
  if (!SHA.test(candidate))
    return refuse('candidate', 'unreadable', `candidate ${JSON.stringify(candidate)} is not a commit sha`)
  if (!base || base.startsWith('-'))
    return refuse('candidate', 'unreadable', `the PR base ${JSON.stringify(base ?? null)} is not a branch name`)
  if (!SHA.test(baseTip)) return refuse('candidate', 'unreadable', `PR base ${base} has no commit sha`)
  return { base }
}

async function candidateRoot(cwd: string, git: Git): Promise<string | Refusal> {
  const args = ['rev-parse', '--show-toplevel']
  const top = await git(cwd, args)
  if (top.code !== 0) return refuse('candidate', 'unreadable', gitError(args, top))
  const toplevel = oneLine(top.stdout)
  if (!toplevel || !isAbsolute(toplevel))
    return refuse('candidate', 'unreadable', `git rev-parse --show-toplevel gave no root for ${cwd}`)
  return toplevel
}

async function checkoutBindsCandidate(toplevel: string, candidate: string, git: Git): Promise<Refusal | null> {
  const args = ['rev-parse', '--verify', 'HEAD^{commit}']
  const tip = await git(toplevel, args)
  if (tip.code !== 0) return refuse('candidate', 'unreadable', `the local tip cannot be read — ${gitError(args, tip)}`)
  if (oneLine(tip.stdout) !== candidate)
    return refuse(
      'candidate',
      'unbound',
      `the local tip ${oneLine(tip.stdout)} is not candidate ${candidate}: land from the checkout of the reviewed head`,
    )
  return null
}

function declared(sides: readonly [string, TreeEntry[]][], path: string): Declared[] {
  const out: Declared[] = []
  for (const [at, tree] of sides) {
    const entry = tree.find((item) => item.path === path)
    if (entry && !out.some((seen) => seen.entry.path === entry.path && seen.entry.oid === entry.oid))
      out.push({ at, entry })
  }
  return out
}

function candidateCore(
  toplevel: string,
  candidate: string,
  base: string,
  baseTip: string,
  entries: TreeEntry[],
  baseEntries: TreeEntry[],
): CandidateCore {
  const sides: [string, TreeEntry[]][] = [
    [baseTip, baseEntries],
    [candidate, entries],
  ]
  return {
    toplevel,
    candidate,
    base,
    baseTip,
    changeFiles: entries
      .map((entry) => entry.path)
      .filter((path) => path.startsWith(CHANGES_DIR) && path.endsWith('.sem'))
      .sort(),
    stacks: declared(sides, STACK),
    adapters: declared(sides, ASSERTLEDGER_CONFIG),
  }
}

/**
 * What the base and the candidate commit, bound to the repository root and to a
 * local tip that is the candidate. Applicability is the union of the established
 * base commit and candidate, so a PR cannot exempt itself by deleting a
 * declaration: Semctx applies when either holds `.semctx`. Semctx runs only
 * under the candidate's committed config, which must equal the base's when the
 * base commits one (a PR never relaxes the policy it is judged by). `absent` is
 * only when neither tree has Semctx state. Anything else refuses: Git errors, a
 * missing or corrupt base or candidate, a malformed config, committed working
 * state, changed configurations, or Semctx state without a committed config.
 */
export async function candidateFacts(
  cwd: string,
  candidate: string,
  base: string | undefined,
  baseTip: string,
  git: Git,
): Promise<CandidateFacts | Refusal> {
  const input = candidateInput(candidate, base, baseTip)
  if ('ok' in input) return input
  const toplevel = await candidateRoot(cwd, git)
  if (typeof toplevel !== 'string') return toplevel
  const unbound = await checkoutBindsCandidate(toplevel, candidate, git)
  if (unbound) return unbound
  const entries = await declarations(git, toplevel, candidate)
  if (entries instanceof Error)
    return refuse('candidate', 'unreadable', `candidate ${candidate} cannot be read — ${entries.message}`)
  const baseEntries = await declarations(git, toplevel, baseTip)
  const baseRef = `origin/${input.base}`
  if (baseEntries instanceof Error)
    return refuse('candidate', 'unreadable', `${baseRef} cannot be read — ${baseEntries.message}`)
  const semctx = await semctxFacts(git, toplevel, candidate, baseRef, entries, baseEntries)
  if ('ok' in semctx) return semctx
  return { ...candidateCore(toplevel, candidate, input.base, baseTip, entries, baseEntries), ...semctx }
}
