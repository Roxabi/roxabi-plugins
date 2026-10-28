import { expect } from 'vitest'
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

const VERSION = 'a'.repeat(64)
const RAW_DIGEST = 'b'.repeat(64)

export function acceptedOwnUw(number: number): ChildFacts['ownUw'] {
  const uw = { repository: 'o/r', target: `o/r#${number}` }
  const source = { scope: uw, recordId: `mandate-${number}`, kind: 'mandate' as const }
  const allocation = { scope: uw, recordId: `identity-${number}`, kind: 'spec-identity' as const }
  return {
    status: 'accepted',
    graphComplete: true,
    identityAllocations: [{ id: 'C1', allocationRef: allocation }],
    accepted: {
      ref: { uw, version: VERSION, sourceAccepted: source },
      snapshot: {
        spec: {
          format: 'omp-build-spec-content/1',
          version: VERSION,
          criteria: [{ id: 'C1', statement: 'it works' }],
          invariants: [],
          exclusions: [],
          openQuestions: [],
          sections: { origin: '', context: '', change: '' },
        },
        raw: { reference: `o/r#${number}`, body: '', bodySha256: RAW_DIGEST, lastEditedAt: null },
      },
      tier: 'S',
      children: [],
      chain: [{ kind: 'mandate', source, version: VERSION }],
      sourceRefs: [source],
    },
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
    epicFix: false,
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
  expect(got).toMatchObject(step)
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
/** The epic-fix ticket, merged after the others: it moves the range end. */
export const FIX = child(4, { epicFix: true, state: 'CLOSED', prs: [landed(4, T3, sha('c'), sha('d'))] })
export const FIXED = `${sha('1')}..${sha('d')}`

export const review = (verdict: 'clean' | 'blocking', range: string, run = RUN) => ({ run, verdict, range })
export const hook = (result: HookRecord['result'], at: string, run = RUN): HookRecord => ({ run, result, sha: at })
/** All done and the final review clean for the current range. */
export const reviewed = (hooks: HookRecord[]) => facts(DONE, { reviews: [review('clean', RANGE)], hooks })
