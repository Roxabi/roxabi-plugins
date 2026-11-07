import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameOwnSpecRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { replayForMandate } from './uw-identity-replay.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import {
  AcceptedSpecDiscovery,
  acceptedMandateKey,
  assessmentOwnRefs,
  type Chain,
  type StructuralOperands,
} from './workflow-accepted-spec-discovery.ts'
import { createCompatibilityOperands, matchesAcceptedOrigin } from './workflow-accepted-spec-operands.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult, CompatibilityOperandReader } from './workflow-accepted-spec-types.ts'
import { constraintCompatibilityProblem } from './workflow-constraint-compatibility.ts'
import { type MandateRecord, mandatesOf } from './workflow-control.ts'
import { compatibilityStateProblem } from './workflow-coverage-names.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'
import { type AssessResultRecord, specChainFailure } from './workflow-spec-assessment.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'

type AcceptedSpecRead = {
  latest(mandate: MandateRecord): AcceptedSpecResult
  at(mandate: MandateRecord, target: OwnSpecRef): AcceptedSpecResult
  prefixes(
    mandate: MandateRecord,
  ): { ok: true; prefixes: readonly AcceptedOwnSpec[] } | Extract<AcceptedSpecResult, { ok: false }>
  operands: CompatibilityOperandReader
}

function frameInputsProblem(
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
): Result<never> | null {
  const historiesByScope = new Map<string, DecodedHistory>()
  for (const history of histories) {
    const scope = `${history.source.scope.repository}\0${history.source.scope.target}`
    const previous = historiesByScope.get(scope)
    if (previous !== undefined && canonicalValueDigest(previous) !== canonicalValueDigest(history))
      return { ok: false, diagnostics: [diagnostic('ambiguous', 'Conflicting histories claim the same scope')] }
    historiesByScope.set(scope, history)
  }
  if (replayContext !== undefined) {
    const matches = new Set(
      histories.flatMap((history) =>
        mandatesOf(history)
          .filter((candidate) => replayForMandate(history, candidate, replayContext))
          .map((candidate) => `${candidate.repository}\0${candidate.target}\0${candidate.recordId}`),
      ),
    )
    if (matches.size !== 1)
      return {
        ok: false,
        diagnostics: [diagnostic('action-uncertain', 'Assessment replay does not identify one scoped mandate start')],
      }
  }
  return null
}

function prefixUnavailable(message: string): Result<never> {
  return { ok: false, diagnostics: [diagnostic('accepted-prefix-unavailable', message)] }
}

class RequiredAcceptedChains {
  private readonly required: Set<string>
  private readonly pending: string[]

  constructor(
    private readonly chains: ReadonlyMap<string, StructuralOperands>,
    private readonly histories: readonly DecodedHistory[],
    private readonly operands: CompatibilityOperandReader,
    own: string,
  ) {
    this.required = new Set([own])
    this.pending = [own]
  }

  validate(extra?: AssessResultRecord): Result<undefined> {
    if (extra !== undefined && !this.requireAssessment(extra))
      return prefixUnavailable('Assessment constraint source is missing, ambiguous or has a bad suffix')
    while (this.pending.length) {
      const id = this.pending.shift()
      if (id === undefined) break
      const chain = this.chains.get(id)
      if (!chain) return prefixUnavailable('Required accepted chain is unavailable')
      if (!this.requireInheritance(chain))
        return prefixUnavailable('Inherited accepted chain is missing, ambiguous or has a bad suffix')
      const problem = this.obligationsProblem(chain)
      if (problem !== null) return problem
    }
    return { ok: true, value: undefined }
  }

  private requirePrefix(ref: OwnSpecRef): boolean {
    const matches = [...this.chains.entries()].filter(([, chain]) =>
      chain.prefixes.some((prefix) => sameOwnSpecRef(prefix.ref, ref)),
    )
    const [match] = matches
    if (matches.length !== 1 || match === undefined) return false
    const [id] = match
    if (!this.required.has(id)) {
      this.required.add(id)
      this.pending.push(id)
    }
    return true
  }

  private requireAssessment(record: AssessResultRecord): boolean {
    for (const ref of assessmentOwnRefs(record)) if (!this.requirePrefix(ref)) return false
    return true
  }

  private requireInheritance(chain: StructuralOperands): boolean {
    for (const prefix of chain.prefixes)
      for (const ref of prefix.inheritedOwnSpecRefs) if (!this.requirePrefix(ref)) return false
    return true
  }

  private obligationsProblem(chain: StructuralOperands): Result<never> | null {
    for (const obligation of chain.obligations) {
      if (!this.requireAssessment(obligation.record))
        return prefixUnavailable('Assessment constraint source is missing, ambiguous or has a bad suffix')
      const problem = constraintCompatibilityProblem(
        obligation.record,
        obligation.assessment,
        this.histories,
        this.operands,
      )
      if (problem !== null)
        return { ok: false, diagnostics: [diagnostic('constraint-compatibility-unresolved', problem)] }
    }
    return null
  }
}

function acceptedRead(chains: ReadonlyMap<string, Chain>, operands: CompatibilityOperandReader): AcceptedSpecRead {
  const get = (requested: MandateRecord) => chains.get(acceptedMandateKey(requested))
  const absent = () => specChainFailure('incomplete', 'Requested accepted chain is unavailable in this frame')
  return {
    operands,
    latest(requested) {
      const chain = get(requested)
      return chain ? { ok: true, spec: chain.latest } : absent()
    },
    at(requested, target) {
      const chain = get(requested)
      const matches = chain?.prefixes.filter((prefix) => matchesAcceptedOrigin(prefix, target)) ?? []
      const [match] = matches
      return matches.length === 1 && match !== undefined ? { ok: true, spec: match } : absent()
    },
    prefixes(requested) {
      const chain = get(requested)
      return chain ? { ok: true, prefixes: chain.prefixes } : absent()
    },
  }
}

function qualifiedCompatibilityFailure(
  discovery: AcceptedSpecDiscovery,
  own: string,
  histories: readonly DecodedHistory[],
  refusal: Extract<AcceptedSpecResult, { ok: false }>,
): Result<never> {
  const stopped = discovery.stopped.get(own)
  if (stopped === undefined) return { ok: false, diagnostics: refusal.evidence }
  const structural = new Map<string, StructuralOperands>(discovery.chains)
  for (const [id, trace] of discovery.stopped) structural.set(id, trace)
  const operands = createCompatibilityOperands(structural, histories)
  const authenticated = new RequiredAcceptedChains(structural, histories, operands, own).validate()
  const description = authenticated.ok
    ? compatibilityStateProblem(stopped.stop.assessment.compatibility)
    : `Compatibility diagnostic qualification failed: ${authenticated.diagnostics.map((item) => item.message).join('; ')}`
  return {
    ok: false,
    diagnostics:
      description === null
        ? refusal.evidence
        : refusal.evidence.map((item) => ({ ...item, message: `${item.message}; ${description}` })),
  }
}

/** One lexical, observation-local structural discovery and semantic validation frame. */
function authenticateAcceptedSpecs(
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
  replayContext?: AssessmentReplayContext,
  extra?: AssessResultRecord,
): Result<AcceptedSpecRead> {
  const inputProblem = frameInputsProblem(histories, replayContext)
  if (inputProblem !== null) return inputProblem
  const discovery = new AcceptedSpecDiscovery(histories, replayContext)
  discovery.discover(mandate, extra)
  const own = acceptedMandateKey(mandate)
  const ownFailure = discovery.failures.get(own)
  if (ownFailure) return qualifiedCompatibilityFailure(discovery, own, histories, ownFailure)
  const operands = createCompatibilityOperands(discovery.chains, histories)
  const required = new RequiredAcceptedChains(discovery.chains, histories, operands, own)
  const validated = required.validate(extra)
  if (!validated.ok) return validated
  return { ok: true, value: acceptedRead(discovery.chains, operands) }
}

export function checkAuthenticatedSpecCompatibility(
  record: AssessResultRecord,
  assessment: SpecAssessment,
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
): string | null {
  const frame = authenticateAcceptedSpecs(histories, mandate, undefined, record)
  return frame.ok
    ? constraintCompatibilityProblem(record, assessment, histories, frame.value.operands)
    : frame.diagnostics.map((item) => item.message).join('; ')
}

export function resolveAcceptedSpec(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
): AcceptedSpecResult {
  const frame = authenticateAcceptedSpecs(histories, mandate, replayContext)
  return frame.ok ? frame.value.latest(mandate) : { ok: false, reason: 'incomplete', evidence: frame.diagnostics }
}

export function resolveAcceptedSpecAt(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  target: OwnSpecRef,
  replayContext?: AssessmentReplayContext,
): AcceptedSpecResult {
  const frame = authenticateAcceptedSpecs(histories, mandate, replayContext)
  return frame.ok ? frame.value.at(mandate, target) : { ok: false, reason: 'incomplete', evidence: frame.diagnostics }
}

export function resolveAcceptedSpecPrefixes(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
): { ok: true; prefixes: readonly AcceptedOwnSpec[] } | Extract<AcceptedSpecResult, { ok: false }> {
  const frame = authenticateAcceptedSpecs(histories, mandate, replayContext)
  return frame.ok ? frame.value.prefixes(mandate) : { ok: false, reason: 'incomplete', evidence: frame.diagnostics }
}
