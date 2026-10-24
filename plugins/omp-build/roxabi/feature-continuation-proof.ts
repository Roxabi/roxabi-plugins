import type { Gh } from '../adapters/github/types.ts'
import type { ProofSelector } from '../engine/workflow-reconstruction-types.ts'
import { refreshSelectedBase } from '../skills/feature/proof-candidate.ts'
import { readProofReadiness } from '../skills/feature/proof-readiness.ts'
import { readDecodedHistory } from './feature-context.ts'
import type { Delivery } from './feature-delivery-facts.ts'
import type { GitRunner } from './workflow-pins.ts'

export async function proofSelectorFor(input: {
  cwd: string
  repository: string
  delivery: Delivery | null
  git: GitRunner
  gh: Gh
}): Promise<{ ok: true; selector: ProofSelector } | { ok: false; reason: string }> {
  let baseTip: string | null = null
  if (input.delivery !== null) {
    const refreshed = await refreshSelectedBase(input.cwd, input.delivery.base, input.git, input.gh)
    if (!refreshed.ok) return { ok: false, reason: refreshed.error }
    baseTip = refreshed.tip
  }
  const decoded = input.delivery === null ? null : await readDecodedHistory(input.delivery.scope, input.cwd, input.gh)
  if (decoded !== null && !decoded.ok) return decoded
  const readiness = await readProofReadiness({
    cwd: input.cwd,
    repository: input.delivery?.scope.repository ?? input.repository,
    pr: input.delivery?.number ?? null,
    candidate: input.delivery?.head ?? null,
    base: input.delivery?.base ?? null,
    baseTip,
    history: decoded?.ok === true ? decoded.history : null,
    git: input.git,
    gh: input.gh,
  })
  if (readiness.status === 'unusable') return { ok: false, reason: readiness.reason }
  return { ok: true, selector: readiness.selector }
}
