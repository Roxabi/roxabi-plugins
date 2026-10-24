import { isMap, type Refusal, refuse } from './proof-base'
import type { ChangeResult, SemctxExpected } from './proof-semctx-protocol'

type ChangeInspection = Record<string, unknown> & { sourceRefs: unknown[] }
type ChangeVerification = Record<string, unknown> & { underlying: Record<string, unknown> }

type VerificationEvidence = {
  findings: Record<string, unknown>[]
  pendingEvidence: unknown[]
  openUnknowns: unknown[]
  stale: unknown[]
  preserved: unknown[]
  provedEvidence: unknown[]
}

/** Lifecycles a relevant change may land in; every other known lifecycle refuses. */
const LANDABLE: Record<string, boolean> = {
  active: true,
  partial: true,
  verified: true,
  draft: false,
  blocked: false,
  stale: false,
  superseded: false,
}

function namedInspection(value: unknown, id: string): value is ChangeInspection {
  return isMap(value) && value.id === id && Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0
}

function declaredOnlyBy(inspect: ChangeInspection, path: string): boolean {
  return inspect.sourceRefs.every((ref) => isMap(ref) && ref.file === path)
}

function changeVerification(value: unknown, id: string): value is ChangeVerification {
  return isMap(value) && value.changeId === id && isMap(value.underlying)
}

function correctRange(underlying: Record<string, unknown>, expected: SemctxExpected): boolean {
  return (
    underlying.head === expected.candidate &&
    underlying.mergeBase === expected.mergeBase &&
    underlying.base === expected.mergeBase
  )
}

function knownLifecycle(value: unknown, inspect: Record<string, unknown>): value is string {
  return typeof value === 'string' && value in LANDABLE && value === inspect.lifecycle
}

function canLand(lifecycle: string, historicalProvenance: unknown): boolean {
  return LANDABLE[lifecycle] || (lifecycle === 'superseded' && historicalProvenance !== undefined)
}

function mismatchedHistoricalProvenance(
  lifecycle: string,
  historicalProvenance: unknown,
  inspect: Record<string, unknown>,
): boolean {
  return lifecycle === 'superseded' && historicalProvenance !== undefined && inspect.provenance !== historicalProvenance
}
function hasVerificationEvidence(verify: ChangeVerification): verify is ChangeVerification & VerificationEvidence {
  return (
    Array.isArray(verify.findings) &&
    Array.isArray(verify.pendingEvidence) &&
    Array.isArray(verify.openUnknowns) &&
    Array.isArray(verify.stale) &&
    Array.isArray(verify.preserved) &&
    Array.isArray(verify.provedEvidence) &&
    verify.findings.every(isMap)
  )
}

function blockingFindingText(findings: Record<string, unknown>[]): string {
  return findings
    .filter((finding) => finding.severity !== 'warn')
    .map((finding) => String(finding.message))
    .join('; ')
}

function verifiedContradictions(evidence: VerificationEvidence, underlying: Record<string, unknown>): string[] {
  const contradictions: string[] = []
  if (evidence.findings.length) contradictions.push(`${evidence.findings.length} finding(s)`)
  if (evidence.pendingEvidence.length) contradictions.push(`${evidence.pendingEvidence.length} pending evidence`)
  if (evidence.openUnknowns.length) contradictions.push(`${evidence.openUnknowns.length} open unknown(s)`)
  if (evidence.stale.length) contradictions.push(`${evidence.stale.length} stale link(s)`)
  if (underlying.verdict !== 'PASS') contradictions.push(`impact ${String(underlying.verdict)}`)
  if (evidence.preserved.some((item) => !isMap(item) || (item.state !== 'proved' && item.state !== 'untouched')))
    contradictions.push('an invariant that is neither proved nor untouched')
  return contradictions
}

function verifiedResult(
  id: string,
  name: string,
  lifecycle: string,
  inspect: Record<string, unknown>,
  underlying: Record<string, unknown>,
  evidence: VerificationEvidence,
): ChangeResult | Refusal {
  const contradictions = verifiedContradictions(evidence, underlying)
  if (contradictions.length) {
    return refuse(
      'semctx',
      'verdict',
      `${name} reports VERIFIED with ${contradictions.join(', ')}: contradictory result`,
    )
  }
  const requires = Array.isArray(inspect.requiresEvidence) ? inspect.requiresEvidence : []
  if (!requires.length) {
    return refuse(
      'semctx',
      'verdict',
      `${name} is VERIFIED but requires no evidence: a vacuous result proves nothing — declare its evidence`,
    )
  }
  const provedIds = evidence.provedEvidence.map((item) => (isMap(item) ? item.id : null))
  if (!requires.every((requirement) => provedIds.includes(requirement))) {
    return refuse('semctx', 'verdict', `${name} is VERIFIED but not every required evidence is proved`)
  }
  return { id, verdict: 'VERIFIED', lifecycle, gaps: [] }
}

function partialContradictions(evidence: VerificationEvidence, underlying: Record<string, unknown>): string[] {
  const contradictions: string[] = []
  if (evidence.findings.some((finding) => finding.severity !== 'warn'))
    contradictions.push('a blocking or stale finding')
  if (evidence.stale.length) contradictions.push(`${evidence.stale.length} stale link(s)`)
  if (underlying.verdict !== 'PASS' && underlying.verdict !== 'WARN')
    contradictions.push(`impact ${String(underlying.verdict)}`)
  return contradictions
}

function namedOpen(items: unknown[]): string[] {
  return items.map((item) => (isMap(item) && typeof item.id === 'string' ? item.id : ''))
}

function findingGap(finding: Record<string, unknown>): string {
  if (Array.isArray(finding.refs) && typeof finding.refs[0] === 'string' && finding.refs[0]) return finding.refs[0]
  return String(finding.kind ?? '')
}

function partialResult(
  id: string,
  name: string,
  lifecycle: string,
  underlying: Record<string, unknown>,
  evidence: VerificationEvidence,
): ChangeResult | Refusal {
  if (lifecycle === 'verified') {
    return refuse(
      'semctx',
      'verdict',
      `${name} is closed as verified while its result is PARTIAL: a PARTIAL stays partial`,
    )
  }
  const contradictions = partialContradictions(evidence, underlying)
  if (contradictions.length) {
    return refuse('semctx', 'verdict', `${name} is PARTIAL with ${contradictions.join(', ')}: contradictory result`)
  }
  const open = namedOpen([...evidence.pendingEvidence, ...evidence.openUnknowns])
  if (open.some((gap) => !gap)) {
    return refuse('semctx', 'unreadable', `${name}: a pending evidence or open unknown names no id`)
  }
  const gaps = [...evidence.findings.map(findingGap), ...open]
  if (!gaps.length || gaps.some((gap) => !gap)) {
    return refuse('semctx', 'unjustified', `${name} is PARTIAL with no named gap: a PARTIAL must name each gap`)
  }
  return { id, verdict: 'PARTIAL', lifecycle, gaps: [...new Set(gaps)] }
}

export function changeResult(
  id: string,
  path: string,
  inspect: unknown,
  verify: unknown,
  expected: SemctxExpected,
): ChangeResult | Refusal {
  const name = `change ${id}`
  if (!namedInspection(inspect, id)) {
    return refuse('semctx', 'unbound', `${name}: change inspect did not read a change contract named ${id}`)
  }
  if (!declaredOnlyBy(inspect, path)) return refuse('semctx', 'unbound', `${name} is not declared by ${path} alone`)
  if (!changeVerification(verify, id)) {
    return refuse('semctx', 'unreadable', `${name}: change verify printed no result for it`)
  }
  const underlying = verify.underlying
  if (!correctRange(underlying, expected)) {
    return refuse(
      'semctx',
      'unbound',
      `${name}: verified range ${String(underlying.base)}..${String(underlying.head)} is not ${expected.mergeBase}..${expected.candidate}`,
    )
  }
  const lifecycle = verify.lifecycle
  if (!knownLifecycle(lifecycle, inspect)) {
    return refuse('semctx', 'unreadable', `${name}: unknown lifecycle ${JSON.stringify(lifecycle)}`)
  }
  const historicalProvenance = expected.historicalContracts.get(path)
  if (mismatchedHistoricalProvenance(lifecycle, historicalProvenance, inspect)) {
    return refuse('semctx', 'unbound', `${name}: native provenance does not match its retained Git source`)
  }
  if (!canLand(lifecycle, historicalProvenance)) {
    return refuse(
      'semctx',
      'verdict',
      `${name} is ${lifecycle}; only an active, partial or verified change, or a source-qualified retained companion, lands`,
    )
  }
  if (!hasVerificationEvidence(verify))
    return refuse('semctx', 'unreadable', `${name}: change verify result is incomplete`)
  if (verify.verdict === 'BLOCKED' || verify.verdict === 'STALE') {
    const why = blockingFindingText(verify.findings)
    return refuse('semctx', 'verdict', `${name} is ${verify.verdict}${why ? `: ${why}` : ''}`)
  }
  if (verify.verdict === 'VERIFIED') return verifiedResult(id, name, lifecycle, inspect, underlying, verify)
  if (verify.verdict === 'PARTIAL') return partialResult(id, name, lifecycle, underlying, verify)
  return refuse('semctx', 'unreadable', `${name}: unknown verdict ${JSON.stringify(verify.verdict)}`)
}
