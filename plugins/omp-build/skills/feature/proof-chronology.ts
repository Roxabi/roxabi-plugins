import { semctxInputs } from './proof-association'
import { errorMessage, type Refusal, refuse, STACK } from './proof-base'
import type { CandidateFacts } from './proof-candidate-contract'
import type { Deps, PrBody, Read, SemctxOutcome } from './proof-context'
import { declaresE2e, type Justification, justifyGaps } from './proof-justification'
import { reviewedRecord } from './proof-records'
import type { SelectedRecord, Target } from './proof-review-contract'
import { readSemctxRecord } from './proof-semctx-validation'
import { blob } from './proof-tree'

/** Preserve the existing PARTIAL body chronology policy against the captured body. */
function reviewedBody(target: Target, pull: PrBody): { body: string } | Refusal {
  const { body, lastEditedAt: edited } = pull
  if (edited === null) return { body }
  const reviewed = target.reviewedAt === null ? Number.NaN : Date.parse(target.reviewedAt)
  if (!(Date.parse(edited) < reviewed)) {
    return refuse(
      'semctx',
      'unjustified',
      `the PR #${target.pr} body that justifies the PARTIAL gaps was edited at ${edited}, not before the review record that approved ${target.candidate} (${target.reviewedAt ?? 'no time'}): that review never judged it — re-review the head (skills/feature/proof-chronology.ts reviewedBody)`,
    )
  }
  return { body }
}

export async function admitSemctx(
  facts: CandidateFacts,
  target: Target,
  deps: Deps,
  read: Read,
  found: SelectedRecord,
  capturedBody: PrBody,
): Promise<SemctxOutcome | Refusal> {
  const inputs = await semctxInputs(facts, deps.git)
  if ('ok' in inputs) return inputs
  const results = readSemctxRecord(found.record, {
    repository: read.repository,
    pr: target.pr,
    candidate: target.candidate,
    ...inputs,
    changeFiles: facts.changeFiles,
  })
  if ('ok' in results) return results
  const chronology = reviewedRecord(found.parts, target, 'semctx')
  if (chronology) return chronology
  const changes = results.map(({ id, verdict }) => ({ id, verdict }))
  if (results.every((result) => result.verdict === 'VERIFIED')) return { verdict: 'VERIFIED', changes, gaps: [] }
  const pull = reviewedBody(target, capturedBody)
  if ('ok' in pull) return pull
  const { body } = pull
  // The base's or the candidate's `test_e2e` makes it the proof: deleting it in the PR exempts nothing.
  let e2e: boolean | Error = false
  for (const { at, entry } of facts.stacks) {
    try {
      if (declaresE2e(await blob(deps.git, facts.toplevel, entry))) e2e = true
    } catch (error) {
      e2e = new Error(`${STACK} at ${at} cannot be read: ${errorMessage(error)}`)
      break
    }
  }
  let gaps: Refusal | Justification[]
  try {
    gaps = justifyGaps(results, body, () => {
      if (e2e instanceof Error) throw e2e
      return e2e
    })
  } catch (error) {
    return refuse('semctx', 'unreadable', errorMessage(error))
  }
  if ('ok' in gaps) return gaps
  return { verdict: 'PARTIAL', changes, gaps }
}
