import { CHANGES_DIR, type Git, gitError, oneLine, SHA } from './proof-base'
import type { SemctxConfig } from './proof-candidate-contract'
// ---------------------------------------------------------------------------
// Semctx: the protocol both acquisition and admission derive
// ---------------------------------------------------------------------------

export type Step = { argv: string[]; exit: number; stdout: string }

export type SemctxInvocation = {
  repository: string
  pr: number
  candidate: string
  base: string
  mergeBase: string
  /** Changed `.semctx/semantic/changes/<id>.sem` files in `mergeBase..candidate`, sorted. */
  contracts: string[]
  /** The private checkout the producer ran in. */
  root: string
  tool: { path: string; version: string }
  /** The Semctx configuration the run used (`CandidateFacts.config`), by source and digest. */
  config: { source: SemctxConfig['source']; sha256: string }
  /** `git status --porcelain -z --untracked-files=all` of the private checkout, before and after. */
  status: { before: string; after: string }
  /** Ignored paths of the private checkout after the run. */
  ignored: string[]
}

export type SemctxRecord = { producer: 'semctx'; invocation: SemctxInvocation; native: Step[] }

export const changeIdOf = (path: string) => path.slice(CHANGES_DIR.length, -'.sem'.length)

/** The Semctx argv sequence, after the binary, for one acquisition. */
export function semctxSteps(root: string, contracts: string[], mergeBase: string, candidate: string): string[][] {
  const at = ['--root', root]
  const steps = [
    [...at, 'index', '--json'],
    [...at, 'status', '--json'],
    [...at, 'semantic', 'check', '--json'],
  ]
  for (const id of contracts.map(changeIdOf)) {
    steps.push([...at, 'change', 'inspect', id, '--json'])
    steps.push([...at, 'change', 'verify', id, '--base', mergeBase, '--head', candidate, '--json'])
  }
  steps.push([...at, 'status', '--json'])
  return steps
}

/** Exit codes a recorded step may have; anything else was a protocol failure, never posted. */
export function stepExitAllowed(argv: string[]): number[] {
  const verb = argv.slice(2, 4).join(' ')
  return verb === 'change verify' ? [0, 3] : [0]
}

/** A changed contract file in `mergeBase..candidate`: `A` added, `M` modified. */
export type ChangedContract = { path: string; status: 'A' | 'M' }

/**
 * Changed contract files in `mergeBase..candidate`, sorted by path. Only added
 * or modified `<id>.sem` files directly in `.semctx/semantic/changes/` are
 * supported: a deleted, renamed, retyped or nested contract fails closed.
 */
export async function changedContracts(
  git: Git,
  toplevel: string,
  mergeBase: string,
  candidate: string,
): Promise<ChangedContract[] | Error> {
  const args = ['diff', '--name-status', '-z', '--no-renames', mergeBase, candidate, '--', CHANGES_DIR]
  const diff = await git(toplevel, args)
  if (diff.code !== 0) return new Error(gitError(args, diff))
  const parts = diff.stdout.split('\0')
  const out: ChangedContract[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? ''
    const path = parts[i + 1] ?? ''
    if (!path.endsWith('.sem')) continue
    if (path.slice(CHANGES_DIR.length).includes('/'))
      return new Error(`${path}: a change contract must sit directly in ${CHANGES_DIR}`)
    if (status !== 'A' && status !== 'M') return new Error(`${path}: change contract status ${status} is not supported`)
    out.push({ path, status })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function mergeBaseOf(
  git: Git,
  toplevel: string,
  baseTip: string,
  candidate: string,
): Promise<string | Error> {
  const args = ['merge-base', baseTip, candidate]
  const result = await git(toplevel, args)
  const sha = oneLine(result.stdout)
  if (result.code !== 0 || !SHA.test(sha)) return new Error(gitError(args, result))
  return sha
}

// ---------------------------------------------------------------------------
// Semctx: reading a record against the re-derived inputs
// ---------------------------------------------------------------------------

export type ContractProvenance = 'author' | 'agent' | 'derived'

export type ChangeResult = {
  id: string
  verdict: 'VERIFIED' | 'PARTIAL'
  lifecycle: string
  /** The named native gaps of a PARTIAL: one per warn finding (its first ref, else its kind). */
  gaps: string[]
}

/** The inputs a Semctx record must bind to, re-derived from Git and the PR. */
export type SemctxExpected = {
  repository: string
  pr: number
  candidate: string
  base: string
  mergeBase: string
  contracts: string[]
  changeFiles: string[]
  /** Source-qualified retained companions, never supplied by the producer record. */
  historicalContracts: ReadonlyMap<string, ContractProvenance>
  config: { source: SemctxConfig['source']; sha256: string }
}
