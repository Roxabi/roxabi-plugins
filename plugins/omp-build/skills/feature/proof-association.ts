import { createHash } from 'node:crypto'
import { CHANGES_DIR, type Git, type GitResult, gitError, oneLine, type Refusal, refuse, SHA } from './proof-base'
import type { CandidateFacts } from './proof-candidate-contract'
import { retainedProvenance } from './proof-retained-provenance'
import {
  type ChangedContract,
  type ContractProvenance,
  changedContracts,
  changeIdOf,
  mergeBaseOf,
  type SemctxExpected,
} from './proof-semctx-protocol'

function addedContractRefusal(changed: ChangedContract[], facts: CandidateFacts, mergeBase: string): Refusal | null {
  if (changed.some((contract) => contract.status === 'A')) return null
  const modified = changed.map((contract) => contract.path)
  return refuse(
    'semctx',
    'missing',
    `candidate ${facts.candidate} adds no ${CHANGES_DIR}<id>.sem since ${mergeBase}${modified.length ? ` (it only modifies ${modified.join(', ')}, which cannot stand in for this ticket's own)` : ''}: open the change contract for this ticket (skills/feature/proof-association.ts semctxInputs)`,
  )
}

function resolvedOids(
  contract: ChangedContract,
  result: GitResult,
  args: string[],
): readonly [string, string] | Refusal {
  const oids = oneLine(result.stdout).split('\n')
  const [beforeOid, afterOid] = oids
  if (
    result.code !== 0 ||
    oids.length !== 2 ||
    !beforeOid ||
    !afterOid ||
    !SHA.test(beforeOid) ||
    !SHA.test(afterOid)
  ) {
    return refuse(
      'semctx',
      'unbound',
      `${contract.path}: cannot resolve historical Git blobs — ${gitError(args, result)}`,
    )
  }
  return [beforeOid, afterOid]
}

function invalidBlobOid(sources: readonly [GitResult, GitResult], oids: readonly [string, string]): string | null {
  for (const [index, source] of sources.entries()) {
    const roundTrip = createHash('sha1')
      .update(`blob ${Buffer.byteLength(source.stdout, 'utf8')}\0`)
      .update(source.stdout, 'utf8')
      .digest('hex')
    if (roundTrip !== oids[index]) return oids[index]
  }
  return null
}

async function historicalProvenance(
  facts: CandidateFacts,
  git: Git,
  mergeBase: string,
  contract: ChangedContract,
): Promise<ContractProvenance | null | Refusal> {
  const args = ['rev-parse', `${mergeBase}:${contract.path}`, `${facts.candidate}:${contract.path}`]
  const oids = resolvedOids(contract, await git(facts.toplevel, args), args)
  if ('ok' in oids) return oids
  const sources = await Promise.all([
    git(facts.toplevel, ['cat-file', 'blob', oids[0]]),
    git(facts.toplevel, ['cat-file', 'blob', oids[1]]),
  ])
  const unreadable = sources.find((source) => source.code !== 0)
  if (unreadable)
    return refuse('semctx', 'unbound', `${contract.path}: cannot read historical Git blob — ${unreadable.stderr}`)
  const provenance = retainedProvenance(sources[0].stdout, sources[1].stdout, changeIdOf(contract.path))
  if (provenance === undefined) return null
  const invalid = invalidBlobOid(sources, oids)
  return invalid
    ? refuse('semctx', 'unbound', `${contract.path}: Git blob ${invalid} cannot be read losslessly as UTF-8`)
    : provenance
}

async function readHistoricalContracts(
  facts: CandidateFacts,
  git: Git,
  mergeBase: string,
  changed: ChangedContract[],
): Promise<Map<string, ContractProvenance> | Refusal> {
  const historical = new Map<string, ContractProvenance>()
  for (const contract of changed) {
    if (contract.status !== 'M') continue
    const provenance = await historicalProvenance(facts, git, mergeBase, contract)
    if (provenance === null) continue
    if (typeof provenance !== 'string') return provenance
    historical.set(contract.path, provenance)
  }
  return historical
}

/**
 * The Semctx inputs admission and acquisition derive the same way from Git and
 * the facts. The candidate must add a change contract of its own. Modified
 * companions remain verified beside it; only conserved source transitions qualify as history.
 */
export async function semctxInputs(
  facts: CandidateFacts,
  git: Git,
): Promise<Pick<SemctxExpected, 'base' | 'mergeBase' | 'contracts' | 'historicalContracts' | 'config'> | Refusal> {
  if (!facts.config) return refuse('semctx', 'unreadable', `candidate ${facts.candidate} has no Semctx configuration`)
  const mergeBase = await mergeBaseOf(git, facts.toplevel, facts.baseTip, facts.candidate)
  if (mergeBase instanceof Error)
    return refuse('semctx', 'unreadable', `merge-base with origin/${facts.base}: ${mergeBase.message}`)
  const changed = await changedContracts(git, facts.toplevel, mergeBase, facts.candidate)
  if (changed instanceof Error) return refuse('semctx', 'unbound', changed.message)
  const missing = addedContractRefusal(changed, facts, mergeBase)
  if (missing) return missing
  const historicalContracts = await readHistoricalContracts(facts, git, mergeBase, changed)
  if ('ok' in historicalContracts) return historicalContracts
  return {
    base: facts.base,
    mergeBase,
    contracts: changed.map((contract) => contract.path),
    historicalContracts,
    config: { source: facts.config.source, sha256: facts.config.sha256 },
  }
}
