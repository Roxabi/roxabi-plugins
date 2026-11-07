import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAdmissionHoldCode } from '../engine/uw-framing-hold.ts'
import type { FramingMemberKey } from '../engine/uw-framing-schema.ts'
import type {
  FramingEffect,
  FramingHold,
  FramingJournalHoldCode,
  FramingOperationResult,
} from './uw-framing-contract.ts'

type MemberStep<K extends FramingEffect['kind']> = { kind: K; effectId: string; member: FramingMemberKey }

/** One planned primitive of the confirmed aggregate; edges are journaled on their parent or dependent. */
export type FramingStep = Readonly<
  | MemberStep<'create'>
  | MemberStep<'publish-intent'>
  | MemberStep<'publish-binding'>
  | MemberStep<'publish-claim'>
  | MemberStep<'patch'>
  | { kind: 'publish-identity'; effectId: string; member: FramingMemberKey; event: 'allocate' | 'retire-proposed' }
  | { kind: 'labels'; effectId: string; member: FramingMemberKey; add: readonly string[]; remove: readonly string[] }
  | { kind: 'parent-child'; effectId: string; member: FramingMemberKey; child: FramingMemberKey }
  | { kind: 'blocker'; effectId: string; member: FramingMemberKey; blocker: FramingMemberKey }
  | { kind: 'publish-result'; effectId: string; member: null }
>

export type FramingEffectOutcome = Readonly<{
  status: Exclude<FramingEffect['status'], 'not-attempted'>
  scope: Scope | null
  evidenceRefs: readonly ExternalRecordRef[]
  diagnostics: readonly UwDiagnostic[]
}>

/** Confirmed durable facts only; an uncertain or unconfirmed effect never advances them. */
export type FramingMemberFacts = Readonly<{ scope: Scope | null; intent: boolean; bound: boolean; claimed: boolean }>

export type FramingJournal = {
  record(index: number, outcome: FramingEffectOutcome): void
  effects(): readonly FramingEffect[]
}

/** Immutable per-effect journal: every planned effect starts not-attempted and is replaced exactly once. */
export function createFramingJournal(steps: readonly FramingStep[]): FramingJournal {
  const effects: FramingEffect[] = steps.map((step) =>
    Object.freeze({
      effectId: step.effectId,
      member: step.member,
      kind: step.kind,
      scope: null,
      status: 'not-attempted' as const,
      evidenceRefs: Object.freeze([]),
      diagnostics: Object.freeze([]),
    }),
  )
  return {
    record(index, outcome) {
      const current = effects[index]
      if (current === undefined || current.status !== 'not-attempted')
        throw new Error(`framing-journal-replay:${index}`)
      effects[index] = Object.freeze({
        ...current,
        scope: outcome.scope,
        status: outcome.status,
        evidenceRefs: Object.freeze([...outcome.evidenceRefs]),
        diagnostics: Object.freeze([...outcome.diagnostics]),
      })
    },
    effects: () => Object.freeze([...effects]),
  }
}

function holdCode(effect: FramingEffect, rootKey: FramingMemberKey): FramingJournalHoldCode {
  switch (effect.kind) {
    case 'create':
      if (effect.status === 'outcome-unknown') return 'framing-create-uncertain'
      return effect.member === rootKey ? 'framing-intent-unpublished' : 'framing-member-unbound'
    case 'publish-intent':
      return effect.status === 'failed-before-effect' || effect.status === 'not-attempted'
        ? 'framing-intent-unpublished'
        : 'framing-intent-uncertain'
    case 'publish-binding':
      return 'framing-member-unbound'
    case 'publish-claim':
      return 'framing-member-unclaimed'
    case 'publish-identity':
      return 'framing-identity-unpublished'
    case 'patch':
    case 'labels':
      return 'framing-patch-unapplied'
    case 'parent-child':
    case 'blocker':
      return 'framing-edge-unapplied'
    case 'publish-result':
      return 'framing-result-unpublished'
  }
}

function durable(facts: FramingMemberFacts | undefined): FramingAdmissionHoldCode | null {
  if (facts === undefined) return null
  if (facts.claimed) return 'framing-aggregate-incomplete'
  return facts.bound || facts.intent ? 'framing-binding-unregistered' : null
}

/**
 * Settle a stopped aggregate. `refused` is reserved for zero actual effects; any
 * unknown outcome makes the aggregate uncertain. Holds name the stopping effect
 * and every other member that already owns a Scope or a durable binding.
 */
export function settleFraming(input: {
  effects: readonly FramingEffect[]
  rootKey: FramingMemberKey
  root: Scope | null
  members: ReadonlyMap<FramingMemberKey, FramingMemberFacts>
  diagnostics: readonly UwDiagnostic[]
}): Exclude<FramingOperationResult, { status: 'written' }> {
  const { effects, rootKey, members } = input
  const diagnostics = Object.freeze([...input.diagnostics])
  if (effects.every((effect) => effect.status === 'failed-before-effect' || effect.status === 'not-attempted'))
    return Object.freeze({ status: 'refused' as const, effects: Object.freeze([]) as readonly [], diagnostics })
  const stop = effects.find((effect) => effect.status !== 'confirmed')
  const result = effects.find((effect) => effect.kind === 'publish-result')
  if (stop === undefined || result === undefined) throw new Error('framing-settlement-without-stop')
  const holds: FramingHold[] = []
  const stopFacts = stop.member === null ? undefined : members.get(stop.member)
  holds.push(
    Object.freeze({
      code: holdCode(stop, rootKey),
      member: stop.member,
      scope: stop.scope ?? stopFacts?.scope ?? null,
      effectId: stop.effectId,
      durable: durable(stopFacts),
    }),
  )
  for (const [key, facts] of members) {
    if (key === stop.member || (facts.scope === null && !facts.bound && !facts.intent)) continue
    const pending = effects.find((effect) => effect.member === key && effect.status !== 'confirmed') ?? result
    holds.push(
      Object.freeze({
        code: holdCode(pending, rootKey),
        member: key,
        scope: facts.scope,
        effectId: pending.effectId,
        durable: durable(facts),
      }),
    )
  }
  return Object.freeze({
    status: effects.some((effect) => effect.status === 'outcome-unknown')
      ? ('uncertain' as const)
      : ('partial' as const),
    root: input.root,
    effects,
    holds: Object.freeze(holds),
    diagnostics,
  })
}
