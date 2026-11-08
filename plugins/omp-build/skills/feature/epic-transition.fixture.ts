import { expect } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { resolveSpecIdentityLedger } from '../../engine/uw-identity.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { nextStep } from './epic-next-step'
import type { BranchFacts, ChildFacts, Facts, HookRecord, PrFacts, Report } from './epic-types'

export const BASE = 'main'
export const RUN = 'run00001'
export const EARLIER = 'run00000'
export const OTHER_REPO = 'Roxabi/other'

/** A full 40-char sha made of one hex digit. */
export const sha = (digit: string) => digit.repeat(40)
export const head = (ticket: number) => `feat/${ticket}-child-${ticket}`

export const on = (
  number: number,
  state: 'OPEN' | 'CLOSED' = 'OPEN',
  repo?: string,
): ChildFacts['blockedBy'][number] => (repo ? { number, state, repo } : { number, state })

export function acceptedOwnUw(number: number): ChildFacts['ownUw'] {
  const uw = { repository: 'o/r', target: `o/r#${number}` }
  const content = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'it works' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!content.ok) throw new Error('Invalid declared child Spec')
  const body = renderIssueSpecBody(content.value)
  const parsed = parseIssueSpecBody({ uw, raw: rawSource(uw.target, body, null) })
  if (parsed.status !== 'conformant') throw new Error('Invalid native child Spec')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(uw, {
    recordId: `mandate-${number}`,
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(uw, parsed.snapshot),
  })
  const history = fixtures.historyFrom([mandate])
  const resolved = resolveAcceptedSpec(mandate, [history])
  if (!resolved.ok) throw new Error(`Unconfirmed fixture mandate: ${JSON.stringify(resolved.evidence)}`)
  const identity = resolveSpecIdentityLedger({ uw, history, histories: [history], accepted: resolved.spec })
  if (!identity.ok) throw new Error(`Unconfirmed fixture identity ledger: ${JSON.stringify(identity.diagnostics)}`)
  return {
    status: 'accepted',
    graphComplete: true,
    role: 'leaf',
    identityAllocations: [...identity.value.allocations].map(([id, allocationRef]) => ({ id, allocationRef })),
    accepted: resolved.spec,
  }
}

export function refusedOwnUw(
  reason: Extract<ChildFacts['ownUw'], { status: 'refused' }>['reason'],
  code = reason === 'incomplete' ? 'graph-incomplete' : 'own-spec-unaccepted',
): ChildFacts['ownUw'] {
  return {
    status: 'refused',
    reason,
    diagnostics: [
      {
        code,
        message: code,
        location: { kind: 'native', uw: { repository: 'o/r', target: 'o/r#0' }, connection: 'state' },
        related: [],
      },
    ],
  }
}

/** An open, framed child with no PR, branch, blocker or stop. */
export function child(number: number, over: Partial<ChildFacts> = {}): ChildFacts {
  return {
    number,
    title: `feat(epic): child ${number}`,
    state: 'OPEN',
    labels: ['size:S'],
    body: '## Acceptance criteria\n\n- [ ] it works\n',
    ownUw: acceptedOwnUw(number),
    blockedBy: [],
    stops: [],
    prs: [],
    branches: [],
    ...over,
  }
}

export function branch(name: string, over: Partial<BranchFacts> = {}): BranchFacts {
  return { name, local: true, tip: sha('a'), remoteTip: sha('a'), foreign: null, elsewhere: null, ...over }
}

/** An open PR from the child's branch into the base. */
export function pr(ticket: number, over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 100 + ticket,
    state: 'OPEN',
    base: BASE,
    head: head(ticket),
    headSha: sha('a'),
    mergedAt: null,
    mergeSha: null,
    baseSha: null,
    armed: false,
    exhausted: false,
    ...over,
  }
}

/** A PR merged at `at`: `from` is the base commit it landed on, `to` its merge commit. */
export const landed = (ticket: number, at: string, from: string, to: string, over: Partial<PrFacts> = {}) =>
  pr(ticket, { state: 'MERGED', mergedAt: at, baseSha: from, mergeSha: to, ...over })

export function facts(children: ChildFacts[], over: Partial<Facts> = {}): Facts {
  return {
    epic: 575,
    run: RUN,
    base: BASE,
    baseSha: sha('f'),
    parentIntegration: { ok: true, value: null },
    parentCompletion: null,
    tree: { clean: true, branch: null },
    baseCi: { state: 'green', failed: [], pending: [] },
    landingError: null,
    children,
    reviews: [],
    hooks: [],
    ...over,
  }
}

export type Case = { name: string; facts: Facts; step: Record<string, unknown>; report?: Partial<Report> }

export function decides({ facts: input, step, report }: Case) {
  const got = nextStep(input)
  expect(
    got,
    JSON.stringify({
      got,
      children: input.children.map(({ number, state, completion, blockedBy }) => ({
        number,
        state,
        completion: completion ?? null,
        blockedBy,
      })),
    }),
  ).toMatchObject(step)
  if (report) expect(got.report).toMatchObject(report)
}

export const T1 = '2026-09-01T10:00:00Z'
export const T2 = '2026-09-02T10:00:00Z'
export const T3 = '2026-09-03T10:00:00Z'

/**
 * Every child done: #1 merged last but is still open (staging-train), #2 merged
 * first and closed, #3 closed without a PR. Listed out of merge order.
 */
export const DONE = [
  child(1, { prs: [landed(1, T2, sha('b'), sha('c'))] }),
  child(2, { state: 'CLOSED', prs: [landed(2, T1, sha('1'), sha('2'))] }),
  child(3, { state: 'CLOSED' }),
]
/** First merged baseSha .. last merged mergeSha, by mergedAt. */
export const RANGE = `${sha('1')}..${sha('c')}`

export const hook = (result: HookRecord['result'], at: string, run = RUN): HookRecord => ({ run, result, sha: at })
