import { afterEach, expect, it, vi } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import type { Scope } from '../../engine/record-values.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'
import {
  closure,
  codes,
  effectGuard,
  existingRootAggregate,
  installed,
  numberOf,
  prepare,
} from '../../testing/framing-runtime-fixture.ts'
import { freshOwnSpec } from '../feature-initial-own-spec.ts'
import type { UwOperations } from '../uw-contract.ts'
import { continueFeature } from '../workflow.ts'
import { writtenBoundary } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

const stops = [
  {
    name: 'existing root intent',
    member: 'root',
    suffix: ':intent',
    kind: 'publish-intent',
    hold: 'framing-intent-uncertain',
  },
  {
    name: 'new member binding',
    member: 'foundation',
    suffix: ':binding',
    kind: 'publish-binding',
    hold: 'framing-member-unbound',
  },
  {
    name: 'aggregate result',
    member: null,
    suffix: ':result',
    kind: 'publish-result',
    hold: 'framing-result-unpublished',
  },
] as const

async function checkFresh(
  kind: (typeof stops)[number]['kind'],
  outcome: 'landed' | 'absent',
  subject: Scope,
  operations: UwOperations,
  boundary: ReturnType<typeof writtenBoundary>,
  gh: Gh,
) {
  const read = await operations.readUw(subject)
  expect(read.accepted.status).toBe('absent')
  if (kind === 'publish-result') {
    if (outcome === 'landed') {
      expect(read.admission.aggregate).toMatchObject({ status: 'complete' })
      expect(await freshOwnSpec(subject, read, operations)).not.toHaveProperty('kind')
    } else {
      expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-aggregate-incomplete' })
      expect(await freshOwnSpec(subject, read, operations)).toMatchObject({
        kind: 'blocked',
        reason: 'framing-aggregate-incomplete',
      })
    }
    return
  }
  if (outcome === 'landed') {
    expect(read.admission.aggregate).toMatchObject({ status: 'held', code: 'framing-binding-unregistered' })
    expect(await freshOwnSpec(subject, read, operations)).toMatchObject({
      kind: 'blocked',
      reason: 'framing-binding-unregistered',
    })
    return
  }
  expect(read.admission.aggregate.status).toBe('none')
  const selected = await continueFeature({
    cwd: boundary.principal,
    reference: subject.target,
    control: 'select',
    principal: true,
    gh,
    git: boundary.git,
    uw: operations,
  })
  if (kind === 'publish-binding') {
    expect(codes(read.admission.framed.diagnostics)).toContain('spec-id-unallocated')
    expect(selected).toMatchObject({ kind: 'blocked', reason: 'spec-id-unallocated' })
  } else {
    expect(selected).toEqual({ kind: 'framing', source: { kind: 'issue', uw: subject } })
  }
}

for (const stop of stops) {
  it.each(['landed', 'absent'] as const)(
    `${stop.name}: an unknown POST outcome is %s on a later fresh read`,
    async (outcome) => {
      const boundary = writtenBoundary()
      const native =
        stop.kind === 'publish-intent'
          ? nativeGitHub({ 41: { title: 'Request queue' }, 42: { title: 'Queue storage', parent: 41 } })
          : nativeGitHub()
      let armed = false
      let unreadable = false
      let writesBeforePost = -1
      const gh: Gh = async (cwd, args) => {
        if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
        if (unreadable && !args.includes('POST') && args.some((arg) => /\/issues\/\d+\/comments/.test(arg)))
          throw new Error('History temporarily unavailable after the ambiguous POST')
        try {
          return await native.gh(cwd, args)
        } catch (error) {
          if (armed && args.includes('POST')) unreadable = true
          throw error
        }
      }
      const framing = await installed({ ...native, gh })
      const input = stop.kind === 'publish-intent' ? await existingRootAggregate(framing.operations) : closure()
      const prepared = await prepare(framing.operations, input)
      const guard = effectGuard((point) => {
        if (point.at === 'before-effect' && point.member === stop.member && point.effectId.endsWith(stop.suffix)) {
          armed = true
          writesBeforePost = native.writes.length
          native.injectFault((write) => {
            if (write.kind !== 'comment') return null
            return outcome === 'landed' ? 'lose-response' : 'reject'
          })
        }
        return false
      })
      const result = await framing.operations.frame(prepared, guard.guard)
      if (result.status !== 'uncertain' || result.root === null)
        throw new Error(`Expected an unknown publication: ${JSON.stringify(result)}`)
      const index = result.effects.findIndex((effect) => effect.kind === stop.kind && effect.member === stop.member)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(result.effects.slice(0, index).every((effect) => effect.status === 'confirmed')).toBe(true)
      expect(result.effects[index]).toMatchObject({ kind: stop.kind, status: 'outcome-unknown' })
      expect(result.effects.slice(index + 1).every((effect) => effect.status === 'not-attempted')).toBe(true)
      expect(result.holds[0]).toMatchObject({ code: stop.hold, member: stop.member })
      expect(writesBeforePost).toBeGreaterThanOrEqual(0)
      expect(native.writes.slice(writesBeforePost)).toEqual([
        { kind: 'comment', issue: stop.kind === 'publish-binding' ? 52 : numberOf(result.root) },
      ])
      expect(framing.confirmations()).toBe(1)
      unreadable = false
      native.injectFault(() => null)
      const subject =
        stop.kind === 'publish-binding'
          ? result.effects.find((effect) => effect.kind === 'create' && effect.member === 'foundation')?.scope
          : result.root
      if (!subject) throw new Error('Expected the confirmed member scope')
      if (stop.kind === 'publish-binding') expect(result.holds[0]).toMatchObject({ scope: subject, durable: null })
      await checkFresh(stop.kind, outcome, subject, framing.operations, boundary, gh)
      expect(native.writes).toHaveLength(writesBeforePost + 1)
    },
  )
}
