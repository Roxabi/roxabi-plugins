import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { justifyGaps } from './proof-justification'
import type { ChangeResult, SemctxExpected } from './proof-semctx-protocol'
import { readSemctxRecord } from './proof-semctx-validation'
import { CONTRACT, conserved, GAP, OTHER, REPOSITORY, SEMCTX_CONFIG, shaOf } from './proof-test-support'

const MAIN = shaOf('semctx', 'main')
const VERIFIED = shaOf('semctx', 'fix/1-verified')
const PARTIAL = shaOf('semctx', 'fix/1-partial')
const expectedFor = (pr: number, candidate: string): SemctxExpected => ({
  repository: REPOSITORY,
  pr,
  candidate,
  base: 'main',
  mergeBase: MAIN,
  contracts: [CONTRACT],
  changeFiles: [CONTRACT],
  historicalContracts: new Map(),
  config: { source: 'committed', sha256: createHash('sha256').update(SEMCTX_CONFIG).digest('hex') },
})
type Native = { argv: string[]; exit: number; stdout: string }
type SemctxShape = {
  invocation: {
    candidate: string
    tool: { path: string; version?: string }
    root: string
    status: Record<string, string>
    ignored: string[]
  }
  native: [Native, Native, Native, Native, Native, Native]
}
type NativeJson = {
  id: string
  verdict: string
  lifecycle: string
  freshnessSeal: Record<string, string>
  counts: Record<string, number>
  sourceRefs: { file: string; line: number }[]
  underlying: Record<string, string>
  findings: Record<string, unknown>[]
  lifecycleFindings: { code: string; severity: string; subjectIds: string[] }[] | null
  pendingEvidence: { id?: string; statement: string; proved: boolean; status: string }[]
  openUnknowns: { id: string; statement: string; critical: boolean; present: boolean }[]
  stale: Record<string, unknown>[]
  preserved: { state: string }[]
  provedEvidence: unknown[]
}
const ONE_CHANGE = { verified: VERIFIED, partial: PARTIAL }
function varied(
  name: keyof typeof ONE_CHANGE,
  edit: (record: SemctxShape, stdout: (i: 0 | 1 | 2 | 3 | 4 | 5, change: (json: NativeJson) => void) => void) => void,
): SemctxShape {
  const record = conserved<SemctxShape>('semctx', name, ONE_CHANGE[name])
  edit(record, (i, change) => {
    const step = record.native[i]
    const json: NativeJson = JSON.parse(step.stdout)
    change(json)
    step.stdout = JSON.stringify(json)
  })
  return record
}

describe('readSemctxRecord', () => {
  it('reads the conserved VERIFIED and PARTIAL results of their own candidates', () => {
    expect(readSemctxRecord(conserved('semctx', 'verified', VERIFIED), expectedFor(11, VERIFIED))).toEqual([
      { id: 'change.fx.add', verdict: 'VERIFIED', lifecycle: 'active', gaps: [] },
    ] satisfies ChangeResult[])
    expect(readSemctxRecord(conserved('semctx', 'partial', PARTIAL), expectedFor(10, PARTIAL))).toEqual([
      { id: 'change.fx.add', verdict: 'PARTIAL', lifecycle: 'active', gaps: [GAP] },
    ] satisfies ChangeResult[])
  })

  it.each([
    [
      'underlying base',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.underlying.base = OTHER))),
      /verified range/,
    ],
    [
      'underlying mergeBase',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.underlying.mergeBase = OTHER))),
      /verified range/,
    ],
    [
      'inspect id',
      varied('verified', (_r, stdout) => stdout(3, (s) => (s.id = 'change.fx.other'))),
      /inspect did not read/,
    ],
    [
      'empty sourceRefs',
      varied('verified', (_r, stdout) => stdout(3, (s) => (s.sourceRefs = []))),
      /inspect did not read/,
    ],
    ['invocation candidate', varied('verified', (r) => (r.invocation.candidate = OTHER)), /candidate/],
    [
      'invocation tool',
      varied('verified', (r) => {
        delete r.invocation.tool.version
      }),
      /no tool path\/version/,
    ],
  ])('independent native binding: %s refuses with every surrounding binding correct', (_label, record, error) => {
    const outcome = readSemctxRecord(record, expectedFor(11, VERIFIED))
    expect(outcome).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })
    expect('error' in outcome && outcome.error).toMatch(error)
  })

  it.each<[string, Partial<SemctxExpected>, RegExp]>([
    ['another repository', { repository: 'acme/fork' }, /repository "acme\/app" ≠ "acme\/fork"/],
    ['another PR', { pr: 17 }, /pr 11 ≠ 17/],
    ['another base', { base: 'release' }, /base "main" ≠ "release"/],
    ['another merge base', { mergeBase: OTHER }, /mergeBase/],
    [
      'a change contract the record never analysed',
      {
        contracts: [CONTRACT, '.semctx/semantic/changes/change.fx.note.sem'],
        changeFiles: [CONTRACT, '.semctx/semantic/changes/change.fx.note.sem'],
      },
      /contracts/,
    ],
  ])('a record of %s does not bind', (_label, change, error) => {
    const outcome = readSemctxRecord(conserved('semctx', 'verified', VERIFIED), {
      ...expectedFor(11, VERIFIED),
      ...change,
    })
    expect(outcome).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })
    expect('error' in outcome && outcome.error).toMatch(error)
  })

  it.each([
    [
      'a private checkout left dirty',
      varied('verified', (r) => (r.invocation.status.after = ' M src/a.ts\0')),
      'unbound',
      /not clean/,
    ],
    [
      'a private checkout dirty before the run',
      varied('verified', (r) => (r.invocation.status.before = ' M src/a.ts\0')),
      'unbound',
      /not clean/,
    ],
    [
      'a relative checkout root',
      varied('verified', (r, stdout) => {
        const root = r.invocation.root
        r.invocation.root = 'relative/root'
        for (const step of r.native) step.argv = step.argv.map((arg) => (arg === root ? 'relative/root' : arg))
        for (const i of [1, 5] as const) stdout(i, (s) => (s.freshnessSeal.indexedRepositoryRoot = 'relative/root'))
      }),
      'unbound',
      /no private checkout root/,
    ],
    [
      'ignored Semctx working state in the private checkout',
      varied('verified', (r) => r.invocation.ignored.push('.semctx/working/active-change.sem')),
      'unbound',
      /working state/,
    ],
    [
      'a verify over another range',
      varied('verified', (r) => {
        const verify = r.native[4]
        verify.argv = verify.argv.map((arg) => (arg === MAIN ? OTHER : arg))
      }),
      'unbound',
      /step 5 ran/,
    ],
    ['a step that failed', varied('verified', (r) => (r.native[2].exit = 1)), 'unbound', /step 3 exited 1/],
    [
      'an index that was not FRESH',
      varied('verified', (_r, stdout) => stdout(1, (s) => (s.verdict = 'DIRTY_KNOWN'))),
      'unbound',
      /not FRESH/,
    ],
    [
      'a seal at another head',
      varied('verified', (_r, stdout) => stdout(5, (s) => (s.freshnessSeal.headAtCapture = OTHER))),
      'unbound',
      /sealed at/,
    ],
    [
      'a seal that changed during the run',
      varied('verified', (_r, stdout) => stdout(5, (s) => (s.freshnessSeal.sealHash = `sha256:${'0'.repeat(64)}`))),
      'unbound',
      /seal changed/,
    ],
    [
      'an index of another head, whatever the capture head',
      varied('verified', (_r, stdout) => {
        for (const i of [1, 5] as const) stdout(i, (s) => (s.freshnessSeal.indexedHeadCommit = OTHER))
      }),
      'unbound',
      /sealed at/,
    ],
    [
      'an index of another root',
      varied('verified', (_r, stdout) => {
        for (const i of [1, 5] as const) stdout(i, (s) => (s.freshnessSeal.indexedRepositoryRoot = '/elsewhere'))
      }),
      'unbound',
      /indexed another root/,
    ],
    [
      'a model with more changes than change files',
      varied('verified', (_r, stdout) => stdout(2, (s) => (s.counts.changes = 2))),
      'verdict',
      /declares 2 change/,
    ],
    [
      'a non-terminal change committed outside its own contract file',
      varied('verified', (_r, stdout) =>
        stdout(2, (s) => s.lifecycleFindings?.[0]?.subjectIds.splice(0, 1, 'change.real')),
      ),
      'verdict',
      /change\(s\) change\.real are not committed/,
    ],
    [
      'an active-pointer finding other than a missing pointer',
      varied('verified', (_r, stdout) =>
        stdout(2, (s) =>
          s.lifecycleFindings?.push({ code: 'ACTIVE_CHANGE_POINTER_INVALID', severity: 'warning', subjectIds: [] }),
        ),
      ),
      'unbound',
      /ACTIVE_CHANGE_POINTER_INVALID/,
    ],
    [
      'a check with no lifecycle findings',
      varied('verified', (_r, stdout) => stdout(2, (s) => (s.lifecycleFindings = null))),
      'unreadable',
      /no lifecycleFindings/,
    ],
    [
      'a model with errors',
      varied('verified', (_r, stdout) => stdout(2, (s) => (s.counts.errors = 1))),
      'verdict',
      /semantic check/,
    ],
    [
      'a change read from another file',
      varied('verified', (_r, stdout) =>
        stdout(3, (s) => (s.sourceRefs = [{ file: '.semctx/semantic/changes/other.sem', line: 1 }])),
      ),
      'unbound',
      /not declared by/,
    ],
    [
      'a verify of another head',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.underlying.head = OTHER))),
      'unbound',
      /verified range/,
    ],
    [
      'an unknown lifecycle',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.lifecycle = 'archived'))),
      'unreadable',
      /lifecycle/,
    ],
    [
      'a lifecycle the inspect does not share',
      varied('verified', (_r, stdout) => stdout(3, (s) => (s.lifecycle = 'draft'))),
      'unreadable',
      /lifecycle/,
    ],
    [
      'a blocked change',
      varied('verified', (_r, stdout) => {
        for (const i of [3, 4] as const) stdout(i, (s) => (s.lifecycle = 'blocked'))
      }),
      'verdict',
      /is blocked; only/,
    ],
    [
      'a stale change',
      varied('verified', (_r, stdout) => {
        for (const i of [3, 4] as const) stdout(i, (s) => (s.lifecycle = 'stale'))
      }),
      'verdict',
      /is stale; only/,
    ],
    [
      'a superseded change',
      varied('verified', (_r, stdout) => {
        for (const i of [3, 4] as const) stdout(i, (s) => (s.lifecycle = 'superseded'))
      }),
      'verdict',
      /is superseded; only/,
    ],
    [
      'BLOCKED',
      varied('verified', (_r, stdout) =>
        stdout(4, (s) => {
          s.verdict = 'BLOCKED'
          s.findings = [
            { kind: 'underlying_block', severity: 'block', message: 'invariant touched without a test', refs: [] },
          ]
        }),
      ),
      'verdict',
      /BLOCKED: invariant touched without a test/,
    ],
    [
      'VERIFIED with pending evidence',
      varied('verified', (_r, stdout) =>
        stdout(
          4,
          (s) => (s.pendingEvidence = [{ id: GAP, statement: 'the add test runs', proved: false, status: 'declared' }]),
        ),
      ),
      'verdict',
      /contradictory/,
    ],
    [
      'VERIFIED with an invariant neither proved nor untouched',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.preserved[0].state = 'missing'))),
      'verdict',
      /neither proved nor untouched/,
    ],
    [
      'VERIFIED with a finding',
      varied('verified', (_r, stdout) =>
        stdout(4, (s) => s.findings.push({ kind: 'invariant_unproven', severity: 'warn', message: 'm', refs: [] })),
      ),
      'verdict',
      /with 1 finding\(s\)/,
    ],
    [
      'VERIFIED with an open unknown',
      varied('verified', (_r, stdout) =>
        stdout(4, (s) => s.openUnknowns.push({ id: 'unknown.fx.x', statement: 'x', critical: false, present: true })),
      ),
      'verdict',
      /with 1 open unknown\(s\)/,
    ],
    [
      'VERIFIED with a stale link',
      varied('verified', (_r, stdout) =>
        stdout(4, (s) => s.stale.push({ kind: 'stale_link', severity: 'stale', message: 'gone', refs: [] })),
      ),
      'verdict',
      /with 1 stale link\(s\)/,
    ],
    [
      'VERIFIED with an impact that warns',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.underlying.verdict = 'WARN'))),
      'verdict',
      /with impact WARN/,
    ],
    [
      'VERIFIED with its required evidence unproved',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.provedEvidence = []))),
      'verdict',
      /not every required evidence/,
    ],
    [
      'PARTIAL with no named gap',
      varied('verified', (_r, stdout) => stdout(4, (s) => (s.verdict = 'PARTIAL'))),
      'unjustified',
      /no named gap/,
    ],
    [
      'native output that is not JSON',
      varied('verified', (r) => (r.native[4].stdout = 'ERROR')),
      'unreadable',
      /printed no JSON/,
    ],
  ] as const)('%s refuses', (_label, record, reason, error) => {
    const outcome = readSemctxRecord(record, expectedFor(11, VERIFIED))
    expect(outcome).toMatchObject({ ok: false, producer: 'semctx', reason })
    expect('error' in outcome && outcome.error).toMatch(error)
  })

  describe('a PARTIAL is read from every native field, not from its findings alone', () => {
    const PENDING = { id: 'proof.fx.other-test', statement: 'another test runs', proved: false, status: 'declared' }
    const UNKNOWN = { id: 'unknown.fx.rounding', statement: 'rounding of large sums', critical: false, present: true }
    const expected = expectedFor(10, PARTIAL)
    const rows = (gaps: string[]) => gaps.map((gap) => `| \`${gap}\` | why | ⚠ NO TEST — out-of-scope |`).join('\n')

    it.each([
      [
        'a pending evidence',
        varied('partial', (_r, stdout) => stdout(4, (s) => s.pendingEvidence.push(PENDING))),
        PENDING.id,
      ],
      [
        'an open unknown',
        varied('partial', (_r, stdout) => stdout(4, (s) => s.openUnknowns.push(UNKNOWN))),
        UNKNOWN.id,
      ],
    ])('%s no finding mirrors is a gap that needs its own NO TEST row', (_label, record, gap) => {
      const results = readSemctxRecord(record, expected)
      expect(results).toEqual([{ id: 'change.fx.add', verdict: 'PARTIAL', lifecycle: 'active', gaps: [GAP, gap] }])
      if (!Array.isArray(results)) throw new Error('the varied PARTIAL record does not read')
      expect(justifyGaps(results, rows([GAP]), () => false)).toMatchObject({
        ok: false,
        reason: 'unjustified',
        error: expect.stringContaining(`gap ${gap} has no NO TEST row`),
      })
      expect(justifyGaps(results, rows([GAP, gap]), () => false)).toEqual([
        { gap: GAP, reason: 'out-of-scope' },
        { gap, reason: 'out-of-scope' },
      ])
    })

    it('an impact that only warns keeps the PARTIAL and its gaps', () => {
      const record = varied('partial', (_r, stdout) => stdout(4, (s) => (s.underlying.verdict = 'WARN')))
      expect(readSemctxRecord(record, expected)).toEqual([
        { id: 'change.fx.add', verdict: 'PARTIAL', lifecycle: 'active', gaps: [GAP] },
      ])
    })

    it.each([
      [
        'a stale link',
        varied('partial', (_r, stdout) =>
          stdout(4, (s) => s.stale.push({ kind: 'stale_link', severity: 'stale', message: 'link gone', refs: [] })),
        ),
        'verdict',
        /PARTIAL with 1 stale link\(s\): contradictory/,
      ],
      [
        'an impact that blocks',
        varied('partial', (_r, stdout) => stdout(4, (s) => (s.underlying.verdict = 'BLOCK'))),
        'verdict',
        /PARTIAL with impact BLOCK: contradictory/,
      ],
      [
        'a pending evidence with no id',
        varied('partial', (_r, stdout) => stdout(4, (s) => delete s.pendingEvidence[0]?.id)),
        'unreadable',
        /names no id/,
      ],
      [
        'a blocking finding',
        varied('partial', (_r, stdout) =>
          stdout(4, (s) =>
            s.findings.push({ kind: 'invariant_contradicted', severity: 'block', message: 'm', refs: ['x'] }),
          ),
        ),
        'verdict',
        /PARTIAL with a blocking or stale finding: contradictory/,
      ],
      [
        'a finding that names no gap',
        varied('partial', (_r, stdout) =>
          stdout(4, (s) => s.findings.push({ kind: '', severity: 'warn', message: 'm', refs: [] })),
        ),
        'unjustified',
        /no named gap/,
      ],
    ] as const)('a PARTIAL with %s refuses', (_label, record, reason, error) => {
      const outcome = readSemctxRecord(record, expected)
      expect(outcome).toMatchObject({ ok: false, producer: 'semctx', reason })
      expect('error' in outcome && outcome.error).toMatch(error)
    })
  })
})
