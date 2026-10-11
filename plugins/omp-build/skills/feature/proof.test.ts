/**
 * The landing admission's readers (#768) on the records the real producers
 * conserved (`__fixtures__/proof/records.json`, see `capture.ts`) and on an
 * injected Git. Each refusal is paired with the admitted counterpart it varies;
 * `proof.integration.test.ts` drives the same readers through the real `landPr`.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox'
import {
  admitLanding,
  type ChangeResult,
  candidateFacts,
  findRecord,
  type Git,
  justifyGaps,
  readAssertledgerRecord,
  readSemctxRecord,
  type SemctxExpected,
} from './proof'

type Capture = { sha: Record<string, string>; records: Record<string, { record?: string }> }
type Producer = 'semctx' | 'assertledger'
const RECORDS: Record<Producer, Capture> = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '__fixtures__/proof/records.json'), 'utf8'),
)
const ME = 'operator'
const REPOSITORY = 'acme/app'
const CONTRACT = '.semctx/semantic/changes/change.fx.add.sem'
const GAP = 'proof.fx.add-test'
const C = '1111111111111111111111111111111111111111'
const OTHER = '2222222222222222222222222222222222222222'

function shaOf(producer: Producer, branch: string): string {
  const sha = RECORDS[producer].sha[branch]
  if (!sha) throw new Error(`records.json holds no ${producer} commit for ${branch}`)
  return sha
}

/** A fresh copy of a conserved record, found in a PR comment the way admission finds it. */
function conserved<Shape>(producer: Producer, name: string, candidate: string): Shape {
  const body = RECORDS[producer].records[name]?.record
  if (!body) throw new Error(`records.json holds no ${producer} ${name} record`)
  const found = findRecord([{ author: { login: ME }, body }], ME, producer, candidate)
  if (!('record' in found)) throw new Error(`the ${name} record does not parse`)
  return JSON.parse(JSON.stringify(found.record))
}

const temps: string[] = []
const temp = (name = 'proof-') => {
  const dir = mkdtempSync(path.join(tmpdir(), name))
  temps.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of temps) {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// candidateFacts on an injected Git
// ---------------------------------------------------------------------------

type Entry = { mode?: string; type?: string; oid?: string; path: string }
type Repo = {
  toplevel: string
  principal?: string | null
  tip?: { code: number; stdout: string; stderr: string }
  tree?: Entry[]
  /** `origin/main`'s tree; the candidate's when omitted (a PR that changes no declaration). */
  baseTree?: Entry[]
  blobs?: Record<string, string>
}

function repoGit(repo: Repo): Git {
  const list =
    repo.principal === null
      ? `worktree /srv/app.git\0bare\0\0worktree ${repo.toplevel}\0HEAD ${C}\0detached\0\0`
      : `worktree ${repo.principal ?? repo.toplevel}\0HEAD ${C}\0branch refs/heads/main\0\0`
  const listing = (entries: Entry[]) =>
    entries
      .map(
        (entry) => `${entry.mode ?? '100644'} ${entry.type ?? 'blob'} ${entry.oid ?? 'e'.repeat(40)}\t${entry.path}\0`,
      )
      .join('')
  return async (_cwd, args) => {
    const key = args.join(' ')
    if (key === 'rev-parse --show-toplevel') return { code: 0, stdout: `${repo.toplevel}\n`, stderr: '' }
    if (key === 'rev-parse --verify HEAD^{commit}') return repo.tip ?? { code: 0, stdout: `${C}\n`, stderr: '' }
    if (key === 'worktree list --porcelain -z') return { code: 0, stdout: list, stderr: '' }
    if (args[0] === 'ls-tree' && args[4] === 'refs/remotes/origin/main^{commit}') {
      return { code: 0, stdout: listing(repo.baseTree ?? repo.tree ?? []), stderr: '' }
    }
    if (args[0] === 'ls-tree' && args[4] === `${C}^{commit}`)
      return { code: 0, stdout: listing(repo.tree ?? []), stderr: '' }
    if (args[0] === 'cat-file' && args[2] !== undefined && repo.blobs?.[args[2]] !== undefined) {
      return { code: 0, stdout: repo.blobs[args[2]] as string, stderr: '' }
    }
    return { code: 128, stdout: '', stderr: `fatal: no answer for ${key}` }
  }
}

const CONFIG_OID = 'c'.repeat(40)
const configured = (text = '{"include":["src/**/*.ts"]}', mode = '100644'): Pick<Repo, 'tree' | 'blobs'> => ({
  tree: [{ path: '.semctx/config.json', oid: CONFIG_OID, mode }],
  blobs: { [CONFIG_OID]: text },
})

describe('candidateFacts', () => {
  it('reads genuine absence: no committed .semctx, none on disk at the root', async () => {
    const toplevel = temp()
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel }))).toMatchObject({
      toplevel,
      base: 'main',
      semctx: 'absent',
      config: null,
      adapters: [],
    })
  })

  it.each([
    ['unresolved', undefined],
    ['an option', '-main'],
  ])('a PR base that is %s refuses before Git reads it', async (_label, base) => {
    const toplevel = temp()
    expect(await candidateFacts(toplevel, C, base, repoGit({ toplevel }))).toMatchObject({
      producer: 'candidate',
      reason: 'unreadable',
      error: expect.stringContaining('is not a branch name'),
    })
  })

  it('a failed HEAD probe refuses with its cause; it is never an unborn branch', async () => {
    const toplevel = temp()
    const tip = { code: 128, stdout: '', stderr: "fatal: ambiguous argument 'HEAD^{commit}': unknown revision" }
    const facts = await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, tip }))
    expect(facts).toMatchObject({ ok: false, producer: 'candidate', reason: 'unreadable' })
    expect('error' in facts && facts.error).toContain('the local tip cannot be read')
    expect('error' in facts && facts.error).toContain('unknown revision')
  })

  it('a local tip that is not the candidate refuses as unbound', async () => {
    const toplevel = temp()
    const tip = { code: 0, stdout: `${OTHER}\n`, stderr: '' }
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, tip }))).toMatchObject({
      producer: 'candidate',
      reason: 'unbound',
    })
  })

  it('keeps a root whose path ends in a space and a newline byte for byte', async () => {
    const toplevel = path.join(temp(), 'wt \n')
    mkdirSync(toplevel)
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel }))).toMatchObject({
      toplevel,
      semctx: 'absent',
    })
    mkdirSync(path.join(toplevel, '.semctx'))
    const facts = await candidateFacts(toplevel, C, 'main', repoGit({ toplevel }))
    expect(facts).toMatchObject({ producer: 'semctx', reason: 'ambiguous' })
    expect('error' in facts && facts.error).toContain(JSON.stringify(path.join(toplevel, '.semctx')))
  })

  it.skipIf(process.getuid?.() === 0)('an unreadable root refuses; it is not absence', async () => {
    const locked = temp()
    const toplevel = path.join(locked, 'wt')
    mkdirSync(toplevel)
    chmodSync(locked, 0o000)
    try {
      const facts = await candidateFacts(toplevel, C, 'main', repoGit({ toplevel }))
      expect(facts).toMatchObject({ producer: 'semctx', reason: 'unreadable' })
      expect('error' in facts && facts.error).toContain('EACCES')
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('a bare principal has no checkout to read; the bound root still decides', async () => {
    const toplevel = temp()
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, principal: null }))).toMatchObject({
      semctx: 'absent',
    })
  })

  it('an uncommitted config on disk configures Semctx; every copy on disk must agree', async () => {
    const toplevel = temp()
    const principal = temp()
    for (const dir of [toplevel, principal]) {
      mkdirSync(path.join(dir, '.semctx'))
      writeFileSync(path.join(dir, '.semctx', 'config.json'), SEMCTX_CONFIG)
    }
    const tree = [{ path: '.semctx/semantic/goals.sem' }]
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, principal, tree }))).toMatchObject({
      semctx: 'configured',
      config: {
        source: 'ignored',
        path: path.join(toplevel, '.semctx', 'config.json'),
        sha256: createHash('sha256').update(SEMCTX_CONFIG).digest('hex'),
      },
    })
    writeFileSync(path.join(principal, '.semctx', 'config.json'), SEMCTX_CONFIG.replace('"block"', '"warn"'))
    const facts = await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, principal, tree }))
    expect(facts).toMatchObject({ producer: 'semctx', reason: 'ambiguous' })
    expect('error' in facts && facts.error).toContain(JSON.stringify(path.join(principal, '.semctx', 'config.json')))
  })

  it.each([
    ['only a .gitkeep', '.semctx/working/.gitkeep', { semctx: 'configured' }],
    ['an active-change pointer', '.semctx/working/active-change.sem', { producer: 'semctx', reason: 'ambiguous' }],
  ])('committed working state with %s', async (_label, file, expected) => {
    const toplevel = temp()
    const repo = configured()
    const tree = [...(repo.tree ?? []), { path: file }]
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, ...repo, tree }))).toMatchObject(expected)
  })

  it('committed .semctx without its config is not absence', async () => {
    const toplevel = temp()
    const tree = [{ path: '.semctx/semantic/goals.sem' }]
    expect(await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, tree }))).toMatchObject({
      producer: 'semctx',
      reason: 'ambiguous',
    })
  })

  it.each([
    ['a symlink', configured('x', '120000'), /not a regular file/],
    ['malformed JSON', configured('{'), /malformed/],
    ['a JSON array', configured('[]'), /not a JSON object/],
  ])('a config that is %s refuses as unreadable', async (_label, repo, error) => {
    const toplevel = temp()
    const facts = await candidateFacts(toplevel, C, 'main', repoGit({ toplevel, ...repo }))
    expect(facts).toMatchObject({ producer: 'semctx', reason: 'unreadable' })
    expect('error' in facts && facts.error).toMatch(error)
  })
})

// ---------------------------------------------------------------------------
// readSemctxRecord on the conserved records
// ---------------------------------------------------------------------------

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
  config: { source: 'committed', sha256: createHash('sha256').update(SEMCTX_CONFIG).digest('hex') },
})

type Native = { argv: string[]; exit: number; stdout: string }
/** index, status, check, change inspect, change verify, status — one change. */
type Steps = [Native, Native, Native, Native, Native, Native]
type SemctxShape = { invocation: { status: Record<string, string>; ignored: string[] }; native: Steps }
/** The fields of the native JSON the mutations below vary. */
type NativeJson = {
  verdict: string
  lifecycle: string
  freshnessSeal: Record<string, string>
  counts: Record<string, number>
  sourceRefs: { file: string; line: number }[]
  underlying: Record<string, string>
  findings: Record<string, unknown>[]
  pendingEvidence: string[]
  preserved: { state: string }[]
  provedEvidence: unknown[]
}

/** The verified record with one change; `stdout` edits a native step's JSON. */
function verified(
  edit: (record: SemctxShape, stdout: (i: 0 | 1 | 2 | 3 | 4 | 5, change: (json: NativeJson) => void) => void) => void,
) {
  const record = conserved<SemctxShape>('semctx', 'verified', VERIFIED)
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
      verified((r) => (r.invocation.status.after = ' M src/a.ts\0')),
      'unbound',
      /not clean/,
    ],
    [
      'ignored Semctx working state in the private checkout',
      verified((r) => r.invocation.ignored.push('.semctx/working/active-change.sem')),
      'unbound',
      /working state/,
    ],
    [
      'a verify over another range',
      verified((r) => {
        const verify = r.native[4]
        verify.argv = verify.argv.map((arg) => (arg === MAIN ? OTHER : arg))
      }),
      'unbound',
      /step 5 ran/,
    ],
    ['a step that failed', verified((r) => (r.native[2].exit = 1)), 'unbound', /step 3 exited 1/],
    [
      'an index that was not FRESH',
      verified((_r, stdout) => stdout(1, (s) => (s.verdict = 'DIRTY_KNOWN'))),
      'unbound',
      /not FRESH/,
    ],
    [
      'a seal at another head',
      verified((_r, stdout) => stdout(5, (s) => (s.freshnessSeal.headAtCapture = OTHER))),
      'unbound',
      /sealed at/,
    ],
    [
      'a seal that changed during the run',
      verified((_r, stdout) => stdout(5, (s) => (s.freshnessSeal.sealHash = `sha256:${'0'.repeat(64)}`))),
      'unbound',
      /seal changed/,
    ],
    [
      'a model with more changes than change files',
      verified((_r, stdout) => stdout(2, (s) => (s.counts.changes = 2))),
      'unbound',
      /declares 2 change/,
    ],
    [
      'a model with errors',
      verified((_r, stdout) => stdout(2, (s) => (s.counts.errors = 1))),
      'verdict',
      /semantic check/,
    ],
    [
      'a change read from another file',
      verified((_r, stdout) =>
        stdout(3, (s) => (s.sourceRefs = [{ file: '.semctx/semantic/changes/other.sem', line: 1 }])),
      ),
      'unbound',
      /not declared by/,
    ],
    [
      'a verify of another head',
      verified((_r, stdout) => stdout(4, (s) => (s.underlying.head = OTHER))),
      'unbound',
      /verified range/,
    ],
    [
      'an unknown lifecycle',
      verified((_r, stdout) => stdout(4, (s) => (s.lifecycle = 'archived'))),
      'unreadable',
      /lifecycle/,
    ],
    [
      'BLOCKED',
      verified((_r, stdout) =>
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
      verified((_r, stdout) => stdout(4, (s) => (s.pendingEvidence = [GAP]))),
      'verdict',
      /contradictory/,
    ],
    [
      'VERIFIED with an invariant neither proved nor untouched',
      verified((_r, stdout) => stdout(4, (s) => (s.preserved[0].state = 'missing'))),
      'verdict',
      /neither proved nor untouched/,
    ],
    [
      'VERIFIED with its required evidence unproved',
      verified((_r, stdout) => stdout(4, (s) => (s.provedEvidence = []))),
      'verdict',
      /not every required evidence/,
    ],
    [
      'PARTIAL with no named gap',
      verified((_r, stdout) => stdout(4, (s) => (s.verdict = 'PARTIAL'))),
      'unjustified',
      /no named gap/,
    ],
    [
      'native output that is not JSON',
      verified((r) => (r.native[4].stdout = 'ERROR')),
      'unreadable',
      /printed no JSON/,
    ],
  ] as const)('%s refuses', (_label, record, reason, error) => {
    const outcome = readSemctxRecord(record, expectedFor(11, VERIFIED))
    expect(outcome).toMatchObject({ ok: false, producer: 'semctx', reason })
    expect('error' in outcome && outcome.error).toMatch(error)
  })
})

// ---------------------------------------------------------------------------
// justifyGaps: the closed enum, read from the selected PR body
// ---------------------------------------------------------------------------

describe('justifyGaps', () => {
  const partial: ChangeResult[] = [{ id: 'change.fx.add', verdict: 'PARTIAL', lifecycle: 'active', gaps: [GAP] }]
  const row = (first: string, reason: string) => `| ${first} | why | ⚠ NO TEST — ${reason} |`
  const noE2e = () => false

  it.each(['infra-not-wired', 'prompt-logic-only', 'out-of-scope'] as const)(
    '%s justifies a gap named in its row',
    (reason) => {
      expect(justifyGaps(partial, row(`\`${GAP}\``, reason), noE2e)).toEqual([{ gap: GAP, reason }])
    },
  )

  it.each([
    ['named only in a later cell', `| other | ${GAP} | ⚠ NO TEST — out-of-scope |`],
    ['named as the prefix of another id', row(`\`${GAP}-2\``, 'out-of-scope')],
  ])('a gap %s has no row', (_label, body) => {
    expect(justifyGaps(partial, body, noE2e)).toMatchObject({ ok: false, reason: 'unjustified' })
  })

  it('reads the candidate’s e2e command only for a ui-manual-only gap', () => {
    const unread = () => {
      throw new Error('the stack was read')
    }
    expect(justifyGaps(partial, row(GAP, 'out-of-scope'), unread)).toEqual([{ gap: GAP, reason: 'out-of-scope' }])
    expect(justifyGaps(partial, row(GAP, 'ui-manual-only'), () => true)).toMatchObject({
      ok: false,
      reason: 'unjustified',
      error: expect.stringContaining('declares commands.test_e2e'),
    })
  })
})

// ---------------------------------------------------------------------------
// readAssertledgerRecord on the conserved detection
// ---------------------------------------------------------------------------

const DETECTED = shaOf('assertledger', 'fix/2-detection')
type LedgerShape = { invocation: Record<string, unknown>; native: { manifest: string; replay: Native } }
type Manifest = { decision: { status: string }; evidenceContext: { worlds: { id: string; provenance: string }[] } }

function detection(edit: (record: LedgerShape, manifest: Manifest) => void = () => {}) {
  const record = conserved<LedgerShape>('assertledger', 'detection', DETECTED)
  const manifest: Manifest = JSON.parse(record.native.manifest)
  edit(record, manifest)
  record.native.manifest = JSON.stringify(manifest)
  return record
}

/** The reference world assertledger derived from Git for the capture. */
function reference(manifest: Manifest): { provenance: string } {
  const world = manifest.evidenceContext.worlds.find((candidate) => candidate.id === 'fixed')
  if (!world) throw new Error('the conserved manifest has no reference world')
  return world
}

function treeOf(record: LedgerShape): string {
  const provenance: { tree: string } = JSON.parse(reference(JSON.parse(record.native.manifest)).provenance)
  return provenance.tree
}
const ledgerExpected = { repository: REPOSITORY, pr: 20, candidate: DETECTED, tree: treeOf(detection()) }

describe('readAssertledgerRecord', () => {
  it('reads the conserved detection of its candidate', () => {
    expect(readAssertledgerRecord(detection(), ledgerExpected)).toBe('detection')
  })

  it.each([
    [
      "the kit adapter's request-authored provenance",
      detection((_r, m) => (reference(m).provenance = `working tree of ${DETECTED.slice(0, 7)}; node v24.18.1`)),
      'unbound',
      /binds nothing/,
    ],
    [
      'a reference world of another commit',
      detection((_r, m) => {
        const world = reference(m)
        world.provenance = JSON.stringify({ ...JSON.parse(world.provenance), commit: OTHER })
      }),
      'unbound',
      /is 2222/,
    ],
    [
      'a replay that is not valid',
      detection((r) => (r.native.replay.stdout = '{"valid":false}')),
      'unreadable',
      /replay valid/,
    ],
    ['another PR', detection((r) => (r.invocation.pr = 21)), 'unbound', /pr 21 ≠ 20/],
    [
      'a decision that is not VERIFIED (a miss)',
      detection((_r, m) => (m.decision.status = 'NOT_VERIFIED')),
      'verdict',
      /no detection .*NOT_VERIFIED/,
    ],
  ] as const)('%s refuses', (_label, record, reason, error) => {
    const outcome = readAssertledgerRecord(record, ledgerExpected)
    expect(outcome).toMatchObject({ ok: false, producer: 'assertledger', reason })
    expect(typeof outcome === 'object' && outcome.error).toMatch(error)
  })

  it('a tree that is not the candidate’s does not bind', () => {
    expect(readAssertledgerRecord(detection(), { ...ledgerExpected, tree: OTHER })).toMatchObject({ reason: 'unbound' })
  })

  it('the WEAK_ORACLE the producer computed refuses', () => {
    const weak = shaOf('assertledger', 'fix/2-weak')
    const record = conserved<LedgerShape>('assertledger', 'weak', weak)
    const tree = treeOf(record)
    expect(readAssertledgerRecord(record, { repository: REPOSITORY, pr: 21, candidate: weak, tree })).toMatchObject({
      reason: 'verdict',
      error: expect.stringContaining('WEAK_ORACLE'),
    })
  })
})

// ---------------------------------------------------------------------------
// admitLanding: what it asks for, by applicability
// ---------------------------------------------------------------------------

describe('admitLanding', () => {
  const silent = async () => {
    throw new Error('GitHub was asked')
  }

  it('genuine absence with no adapter admits without asking GitHub anything', async () => {
    const toplevel = temp()
    expect(
      await admitLanding(
        toplevel,
        { pr: 5, candidate: C, base: 'main' },
        { gh: silent, git: repoGit({ toplevel }), comments: silent },
      ),
    ).toEqual({ ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } })
  })

  it('an unreadable comment list authorizes nothing: it throws', async () => {
    const toplevel = temp()
    const git = repoGit({ toplevel, ...configured() })
    const gh = async () => JSON.stringify({ nameWithOwner: REPOSITORY })
    await expect(
      admitLanding(toplevel, { pr: 5, candidate: C, base: 'main' }, { gh, git, comments: silent }),
    ).rejects.toThrow('GitHub was asked')
  })

  it.each([
    ['declares no adapter', '{"framework":"node:test"}', { reason: 'ambiguous' }],
    ['is not JSON', '{', { reason: 'unreadable' }],
  ])('an assertledger config that %s refuses before any ticket read', async (_label, text, expected) => {
    const toplevel = temp()
    const oid = 'a'.repeat(40)
    const git = repoGit({ toplevel, tree: [{ path: 'assertledger.config.json', oid }], blobs: { [oid]: text } })
    const gh = async (_cwd: string, args: string[]) => {
      if (args.includes('graphql')) throw new Error('the ticket was read')
      return JSON.stringify({ nameWithOwner: REPOSITORY })
    }
    expect(
      await admitLanding(toplevel, { pr: 5, candidate: C, base: 'main' }, { gh, git, comments: silent }),
    ).toMatchObject({
      ok: false,
      producer: 'assertledger',
      ...expected,
    })
  })

  it.each([
    ['a truncated closing-issue list throws rather than deciding on part of it', 26],
    ['a complete one decides', 25],
  ])('%s', async (_label, totalCount) => {
    const toplevel = temp()
    const git = repoGit({ toplevel, tree: [{ path: 'scripts/kit/assertledger/vitest-adapter.mjs' }] })
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      title: 'feat: more',
      labels: { totalCount: 0, nodes: [] },
      issueType: { name: 'feat' },
    }))
    const gh = async (_cwd: string, args: string[]) =>
      args.includes('graphql')
        ? JSON.stringify({
            data: {
              repository: {
                pullRequest: { headRefName: 'feat/5-more', closingIssuesReferences: { totalCount, nodes } },
              },
            },
          })
        : JSON.stringify({ nameWithOwner: REPOSITORY })
    const admitted = admitLanding(toplevel, { pr: 5, candidate: C, base: 'main' }, { gh, git, comments: silent })
    if (totalCount === nodes.length) {
      expect(await admitted).toEqual({ ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    } else {
      await expect(admitted).rejects.toThrow(/closing issues of PR #5 could not be read/)
    }
  })
})
