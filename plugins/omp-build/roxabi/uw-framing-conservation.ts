import type { IssueSpecAnalysis } from '../adapters/github-native/uw-spec.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type {
  FramingAccountedDecision,
  FramingDestinationMerge,
  FramingMemberKey,
  FramingSourceOrigin,
} from '../engine/uw-framing-schema.ts'
import type { SpecDraft } from '../engine/uw-spec-schema.ts'
import { contentCoverageDiagnostics, unaccountedTargetDiagnostics } from './uw-normalization-conservation.ts'
import {
  analysisSources,
  type ConservationSubject,
  diagnostic,
  draftTargets,
  obligationTargetKey,
  type Source,
  sourceDiagnostic,
  spanKey,
  validateDecision,
} from './uw-normalization-decision.ts'
export type FramingConservationInput = {
  members: readonly {
    member: FramingMemberKey
    subject: ConservationSubject
    draft: SpecDraft
    decisions: readonly FramingAccountedDecision[]
    merges: readonly FramingDestinationMerge[]
  }[]
  sources: readonly {
    origin: FramingSourceOrigin
    identity: 'native-ledger' | 'none'
    analysis: IssueSpecAnalysis
  }[]
}

function qualifiedSourceKey(origin: FramingSourceOrigin, span: Source['span']): string {
  return JSON.stringify([origin.kind, origin.kind === 'native' ? origin.member : origin.id, spanKey(span)])
}

function originKey(origin: FramingSourceOrigin): string {
  return JSON.stringify([origin.kind, origin.kind === 'native' ? origin.member : origin.id])
}

type FramingMember = FramingConservationInput['members'][number]
type FramingSourceEntry = FramingConservationInput['sources'][number]
type FramingSources = {
  sources: Map<string, { source: Source; origin: FramingSourceOrigin; identity: 'native-ledger' | 'none' }>
  origins: Set<string>
}
type FramingMemberAccounting = {
  member: FramingMember
  registry: FramingSources
  accounted: Set<string>
  diagnostics: UwDiagnostic[]
  draft: ReturnType<typeof draftTargets>
  claimed: Set<string>
  coverage: Map<string, { start: number; end: number }[]>
  validMerges: Set<string>
}

function registerFramingSources(
  entry: FramingSourceEntry,
  subject: ConservationSubject,
  registry: FramingSources,
  diagnostics: UwDiagnostic[],
): void {
  if ((entry.origin.kind === 'native') !== (entry.identity === 'native-ledger')) {
    diagnostics.push(
      diagnostic(subject, 'normalization-source-origin-invalid', 'Source identity does not match its origin'),
    )
    return
  }
  const origin = originKey(entry.origin)
  if (registry.origins.has(origin)) {
    diagnostics.push(
      diagnostic(
        subject,
        'normalization-source-origin-duplicate',
        'Each source origin has exactly one parser analysis',
      ),
    )
    return
  }
  registry.origins.add(origin)
  for (const source of analysisSources(entry.analysis)) {
    const key = qualifiedSourceKey(entry.origin, source.span)
    if (registry.sources.has(key)) {
      diagnostics.push(diagnostic(subject, 'normalization-source-duplicate', 'Source origin and span are not unique'))
    } else {
      registry.sources.set(key, { source, origin: entry.origin, identity: entry.identity })
    }
  }
}

function mergeDecisionSources(member: FramingMember, target: string): string[] {
  return member.decisions.flatMap(({ origin, decision }) => {
    if (
      origin === null ||
      decision.kind === 'new' ||
      decision.kind === 'removed' ||
      (decision.target.kind !== 'existing' && decision.target.kind !== 'new') ||
      obligationTargetKey(decision.target) !== target
    )
      return []
    return [qualifiedSourceKey(origin, decision.source)]
  })
}

function isExactFramingMerge(
  member: FramingMember,
  merge: FramingDestinationMerge,
  sources: FramingSources['sources'],
): boolean {
  const target = obligationTargetKey(merge.target)
  const listed = merge.sources.map((ref) => qualifiedSourceKey(ref.origin, ref.span))
  const actual = mergeDecisionSources(member, target)
  const resolved = listed.map((key) => sources.get(key))
  const native = resolved.filter((entry) => entry?.origin.kind === 'native')
  const existingId = merge.target.kind === 'existing' ? merge.target.id : null
  const hasNewClaim = member.decisions.some(
    ({ decision }) =>
      decision.kind === 'new' && decision.target.kind === 'new' && obligationTargetKey(decision.target) === target,
  )
  return (
    !hasNewClaim &&
    listed.length >= 2 &&
    new Set(listed).size === listed.length &&
    actual.length === listed.length &&
    new Set(actual).size === actual.length &&
    listed.every((key) => actual.includes(key)) &&
    resolved.every((entry) => entry !== undefined && 'id' in entry.source) &&
    (existingId !== null
      ? native.some((entry) => entry !== undefined && 'id' in entry.source && entry.source.id === existingId)
      : native.every((entry) => entry !== undefined && 'id' in entry.source && entry.source.id === null))
  )
}

function validFramingMerges(
  member: FramingMember,
  sources: FramingSources['sources'],
  diagnostics: UwDiagnostic[],
): Set<string> {
  const valid = new Set<string>()
  const seen = new Set<string>()
  for (const merge of member.merges) {
    const target = obligationTargetKey(merge.target)
    if (!seen.has(target) && isExactFramingMerge(member, merge, sources)) {
      valid.add(target)
    } else {
      diagnostics.push(
        diagnostic(
          member.subject,
          'normalization-merge-invalid',
          'Declared merge must exactly name its source claims without losing native identity',
        ),
      )
    }
    seen.add(target)
  }
  return valid
}

function accountFramingDecision(state: FramingMemberAccounting, entry: FramingAccountedDecision): void {
  const { origin, decision } = entry
  const { member, registry, diagnostics } = state
  if (decision.kind === 'new') {
    if (origin !== null) {
      diagnostics.push(
        diagnostic(member.subject, 'normalization-source-origin-invalid', 'New decisions have no source origin'),
      )
      return
    }
    diagnostics.push(
      ...validateDecision(decision, member.subject, new Map(), new Set(), state.draft, state.claimed, state.coverage),
    )
    return
  }
  if (origin === null) {
    diagnostics.push(
      diagnostic(member.subject, 'normalization-source-origin-invalid', 'Source decision requires an origin'),
    )
    return
  }
  const key = qualifiedSourceKey(origin, decision.source)
  const resolved = registry.sources.get(key)
  if (resolved === undefined) {
    diagnostics.push(
      registry.origins.has(originKey(origin))
        ? sourceDiagnostic(member.subject, 'normalization-source-unknown')
        : diagnostic(member.subject, 'normalization-source-origin-unknown', 'Source origin was not supplied'),
    )
    return
  }
  if (state.accounted.has(key)) {
    diagnostics.push(sourceDiagnostic(member.subject, 'normalization-source-duplicate'))
    return
  }
  state.accounted.add(key)
  if (origin.kind === 'native' && origin.member !== member.member) {
    diagnostics.push(
      diagnostic(member.subject, 'normalization-source-foreign-member', 'Native source belongs to another member'),
    )
    return
  }
  const merged =
    decision.kind !== 'removed' &&
    (decision.target.kind === 'existing' || decision.target.kind === 'new') &&
    state.validMerges.has(obligationTargetKey(decision.target))
  diagnostics.push(
    ...validateDecision(
      decision,
      member.subject,
      new Map([[spanKey(decision.source), resolved.source]]),
      new Set(),
      state.draft,
      state.claimed,
      state.coverage,
      { identity: resolved.identity, merged },
    ),
  )
}

function accountFramingMember(
  member: FramingMember,
  registry: FramingSources,
  accounted: Set<string>,
  diagnostics: UwDiagnostic[],
): void {
  const state: FramingMemberAccounting = {
    member,
    registry,
    accounted,
    diagnostics,
    draft: draftTargets({ draft: member.draft }),
    claimed: new Set<string>(),
    coverage: new Map<string, { start: number; end: number }[]>(),
    validMerges: validFramingMerges(member, registry.sources, diagnostics),
  }
  for (const decision of member.decisions) accountFramingDecision(state, decision)
  diagnostics.push(...unaccountedTargetDiagnostics(member.subject, state.draft, state.claimed))
  diagnostics.push(...contentCoverageDiagnostics(member.subject, state.draft, state.coverage))
}

/** Aggregate-wide source accounting; singleton and aggregate share the same decision validators. */
export function validateFramingConservation(input: FramingConservationInput): readonly UwDiagnostic[] {
  const first = input.members[0]
  if (first === undefined) throw new Error('framing-conservation-members-required')
  const diagnostics: UwDiagnostic[] = []
  const registry: FramingSources = { sources: new Map(), origins: new Set() }
  for (const entry of input.sources) registerFramingSources(entry, first.subject, registry, diagnostics)
  const accounted = new Set<string>()
  for (const member of input.members) accountFramingMember(member, registry, accounted, diagnostics)
  for (const key of registry.sources.keys()) {
    if (!accounted.has(key)) {
      diagnostics.push(
        diagnostic(
          first.subject,
          'normalization-source-unaccounted',
          'Every parser source must be accounted for exactly once',
        ),
      )
    }
  }
  return diagnostics
}
