import { admitAssertledger } from './proof-assertledger'
import { type Refusal, refuse } from './proof-base'
import { captureReviewInput } from './proof-capture'
import { admitSemctx } from './proof-chronology'
import type { Admission, Deps, PrBody, Read, ReviewSnapshot, SemctxOutcome } from './proof-context'
import { compareApplicableProofPins } from './proof-pins'
import type { Target } from './proof-review-contract'

function boundSnapshot(snapshot: ReviewSnapshot, next: string): { read: Read; body: PrBody; input: string } | Refusal {
  if (!snapshot.read || !snapshot.body || snapshot.input === null) {
    return refuse('candidate', 'unreadable', `the current Spec could not be bound into the review input — ${next}`)
  }
  return { read: snapshot.read, body: snapshot.body, input: snapshot.input }
}

function reviewInputRefusal(target: Target, input: string, next: string): Refusal | null {
  if (target.reviewInput === null) {
    return refuse(
      'candidate',
      'unbound',
      `the approval has no review-input binding and cannot approve the current Spec — ${next}`,
    )
  }
  if (!/^[0-9a-f]{64}$/.test(target.reviewInput)) {
    return refuse(
      'candidate',
      'unreadable',
      `the approval's review-input binding is malformed or unsupported — ${next}`,
    )
  }
  if (target.reviewInput !== input) {
    return refuse(
      'candidate',
      'unbound',
      `the current Spec, config, PR body, or selected producer publication is not the exact input that was reviewed — ${next}`,
    )
  }
  return null
}

/** Admission evaluates the very selections/body whose read binding it compares. */
export async function admitLanding(cwd: string, target: Target, deps: Deps): Promise<Admission> {
  const snapshot = await captureReviewInput(cwd, target, deps)
  if (!snapshot.ok) return snapshot
  if (target.proofPins) {
    const pinned = await compareApplicableProofPins(deps.git, snapshot.facts, target.proofPins)
    if (!pinned.ok) return pinned
  }
  const next = `re-read the exact body and selected producer parts and re-review the same head (skills/feature/proof-admission.ts admitLanding)`
  const bound = boundSnapshot(snapshot, next)
  if ('ok' in bound) return bound
  let semctx: SemctxOutcome = 'absent'
  if (snapshot.semctx) {
    const outcome = await admitSemctx(snapshot.facts, target, deps, bound.read, snapshot.semctx, bound.body)
    if (typeof outcome === 'object' && 'ok' in outcome) return outcome
    semctx = outcome
  }
  if (snapshot.assertledger) {
    const refused = await admitAssertledger(snapshot.facts, target, deps, bound.read, snapshot.assertledger)
    if (refused) return refused
  }
  const refused = reviewInputRefusal(target, bound.input, next)
  if (refused) return refused
  return { ok: true, proof: { semctx, assertledger: snapshot.assertledger ? 'detection' : 'not-applicable' } }
}
