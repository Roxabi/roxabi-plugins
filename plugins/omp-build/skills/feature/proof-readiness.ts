import type { DecodedHistory } from '../../dist/contracts.js'
import type { Diagnostic } from '../../engine/record-values.ts'
import type { ProofSelector } from '../../engine/workflow-reconstruction-types.ts'
import { assertledgerApplies, readAssertledgerRecord } from './proof-assertledger'
import { semctxInputs } from './proof-association'
import { type Gh, type Git, gitError, oneLine, type Producer, type RefusalReason, refuse, SHA } from './proof-base'
import { type CandidateFacts, candidateFacts } from './proof-candidate'
import { findProofRecord, type SelectedRecord } from './proof-records'
import { readSemctxRecord } from './proof-semctx-validation'
export type ProofReadiness =
  | { status: 'ready'; selector: ProofSelector }
  | { status: 'unusable'; reason: string; evidence: Diagnostic[] }

type ReadinessInput = {
  cwd: string
  repository: string
  pr: number | null
  candidate: string | null
  base: string | null
  baseTip: string | null
  history: DecodedHistory | null
  git: Git
  gh: Gh
}

type EstablishedReadiness = {
  cwd: string
  repository: string
  pr: number
  candidate: string
  base: string
  baseTip: string
  history: DecodedHistory | null
  git: Git
  gh: Gh
}

function proofSelector(input: {
  candidateGitSHA: string | null
  applicability: ProofSelector['applicability']
  admission: ProofSelector['admission']
  input: string | null
  evidence: Diagnostic[]
}): ProofSelector {
  return {
    admission: input.admission,
    candidateGitSHA: input.candidateGitSHA,
    input: input.input,
    applicability: input.applicability,
    evidence: input.evidence,
  }
}

function proofEvidence(code: string, message: string): Diagnostic {
  return { code, message }
}

type BoundProof =
  | { status: 'bound'; recordId: string; input: string }
  | { status: 'unbound'; evidence: Diagnostic[] }
  | { status: 'unusable'; reason: string; evidence: Diagnostic[] }

function unboundProof(producer: Producer, reason: RefusalReason, error: string): BoundProof {
  return { status: 'unbound', evidence: [proofEvidence('proof-unbound', refuse(producer, reason, error).error)] }
}

/** The same native-comment check capture uses. Empty or unreadable identity does not bind. */
function nativeProofIdentity(found: SelectedRecord, producer: Producer): BoundProof | null {
  if (found.parts.some((part) => !Number.isSafeInteger(part.id) || Number(part.id) < 1)) {
    return unboundProof(
      producer,
      'unreadable',
      'the selected producer publication has no readable native comment identity',
    )
  }
  return null
}

async function boundSemctx(
  repository: string,
  pr: number,
  candidate: string,
  facts: CandidateFacts,
  history: DecodedHistory,
  git: Git,
): Promise<BoundProof> {
  const found = findProofRecord(history, 'semctx', candidate)
  if ('missing' in found) return unboundProof('semctx', 'missing', found.missing)
  if ('unreadable' in found) return unboundProof('semctx', 'unreadable', found.unreadable)
  const identity = nativeProofIdentity(found, 'semctx')
  if (identity) return identity
  if (facts.config === null) {
    return {
      status: 'unusable',
      reason: 'semctx is configured without a committed config digest',
      evidence: [
        proofEvidence('proof-unusable', `candidate ${candidate} has Semctx state and no committed config digest`),
      ],
    }
  }
  const inputs = await semctxInputs(facts, git)
  if ('ok' in inputs) return unboundProof('semctx', inputs.reason, inputs.error)
  const results = readSemctxRecord(found.record, {
    repository,
    pr,
    candidate,
    ...inputs,
    changeFiles: facts.changeFiles,
  })
  if ('ok' in results) return unboundProof('semctx', results.reason, results.error)
  return { status: 'bound', recordId: found.recordId, input: `semctx-config:${facts.config.sha256}` }
}

async function boundAssertledger(
  repository: string,
  pr: number,
  candidate: string,
  facts: CandidateFacts,
  history: DecodedHistory,
  git: Git,
): Promise<BoundProof> {
  const found = findProofRecord(history, 'assertledger', candidate)
  if ('missing' in found) return unboundProof('assertledger', 'missing', found.missing)
  if ('unreadable' in found) return unboundProof('assertledger', 'unreadable', found.unreadable)
  const identity = nativeProofIdentity(found, 'assertledger')
  if (identity) return identity
  const args = ['rev-parse', `${candidate}^{tree}`]
  const tree = await git(facts.toplevel, args)
  const treeSha = oneLine(tree.stdout)
  if (tree.code !== 0 || !SHA.test(treeSha)) return unboundProof('assertledger', 'unreadable', gitError(args, tree))
  const outcome = readAssertledgerRecord(found.record, { repository, pr, candidate, tree: treeSha })
  if (outcome !== 'detection') return unboundProof('assertledger', outcome.reason, outcome.error)
  return { status: 'bound', recordId: found.recordId, input: `assertledger-tree:${treeSha}` }
}

function ready(
  candidateGitSHA: string | null,
  applicability: ProofSelector['applicability'],
  evidence: Diagnostic[] = [],
  admission: ProofSelector['admission'] = null,
  input: string | null = null,
): ProofReadiness {
  return { status: 'ready', selector: proofSelector({ candidateGitSHA, applicability, admission, input, evidence }) }
}

function unusable(message: string): ProofReadiness {
  return { status: 'unusable', reason: message, evidence: [proofEvidence('proof-unusable', message)] }
}

function readinessTarget(input: ReadinessInput): EstablishedReadiness | ProofReadiness {
  if (input.pr === null || input.candidate === null || input.base === null) return ready(input.candidate, 'required')
  if (input.baseTip === null) {
    return unusable('the selected base tip is missing; establish it with refreshSelectedBase, never baseRefOid')
  }
  return {
    cwd: input.cwd,
    repository: input.repository,
    pr: input.pr,
    candidate: input.candidate,
    base: input.base,
    baseTip: input.baseTip,
    history: input.history,
    git: input.git,
    gh: input.gh,
  }
}

async function applicableReadiness(
  input: EstablishedReadiness,
  facts: CandidateFacts,
  ledger: boolean,
): Promise<ProofReadiness> {
  if (input.history === null || !input.history.source.complete) {
    return unusable(`the complete common proof history for PR #${input.pr} could not be read`)
  }
  const producers: BoundProof[] = []
  if (facts.semctx === 'configured') {
    producers.push(await boundSemctx(input.repository, input.pr, input.candidate, facts, input.history, input.git))
  }
  if (ledger) {
    producers.push(
      await boundAssertledger(input.repository, input.pr, input.candidate, facts, input.history, input.git),
    )
  }
  const unusableProducer = producers.find((producer) => producer.status === 'unusable')
  if (unusableProducer?.status === 'unusable') {
    return { status: 'unusable', reason: unusableProducer.reason, evidence: unusableProducer.evidence }
  }
  const unbound = producers.filter((producer) => producer.status === 'unbound')
  if (unbound.length > 0 || producers.length === 0) {
    return ready(
      input.candidate,
      'required',
      unbound.flatMap((producer) => (producer.status === 'unbound' ? producer.evidence : [])),
    )
  }
  const bound = producers.filter((producer) => producer.status === 'bound')
  const identity = bound.map((producer) => (producer.status === 'bound' ? producer.input : '')).join('\n')
  const recordIds = bound.map((producer) => (producer.status === 'bound' ? producer.recordId : ''))
  if (identity.length === 0 || recordIds.some((recordId) => recordId.length === 0)) {
    return unusable(`PR #${input.pr} proof records did not bind a candidate, input, and record id`)
  }
  return ready(
    input.candidate,
    'required',
    [],
    { ok: true, candidateGitSHA: input.candidate, input: identity, recordIds },
    identity,
  )
}

/**
 * Pre-review proof readiness. Applicability is candidateFacts plus assertledgerApplies,
 * never "a pull request is open". Admission is the existing record readers and native
 * comment identity. It does not call admitLanding and does not require an approving review.
 * A missing pull request is not-started, not an applicable no-op. Unreadable facts, an
 * undecidable assertledger type, a missing established base tip, or incomplete history
 * when a producer applies are unusable, not not-applicable.
 * `baseTip` is the tip from refreshSelectedBase, never baseRefOid.
 */
export async function readProofReadiness(input: {
  cwd: string
  repository: string
  pr: number | null
  candidate: string | null
  base: string | null
  baseTip: string | null
  history: DecodedHistory | null
  git: Git
  gh: Gh
}): Promise<ProofReadiness> {
  const target = readinessTarget(input)
  if ('status' in target) return target
  const facts = await candidateFacts(target.cwd, target.candidate, target.base, target.baseTip, target.git)
  if ('ok' in facts) return unusable(facts.error)
  const ledger = await assertledgerApplies(
    target.cwd,
    facts,
    { pr: target.pr },
    { gh: target.gh, git: target.git },
    target.repository,
  )
  if (typeof ledger === 'object') return unusable(ledger.error)
  if (facts.semctx !== 'configured' && !ledger) return ready(target.candidate, 'not-applicable')
  return applicableReadiness(target, facts, ledger)
}
