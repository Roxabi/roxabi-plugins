import { describe, expect, it } from 'vitest'
import { admitLanding } from './proof-admission'
import { readAssertledgerRecord } from './proof-assertledger'
import type { ProofSemanticContext } from './proof-context'
import { hashReviewInput } from './proof-context-hash'
import {
  ASSERTLEDGER_CONFIG,
  assertledgerConfig,
  BASE_TIP,
  C,
  conserved,
  DETECTED,
  detection,
  type LedgerShape,
  ledgerExpected,
  ME,
  OTHER,
  REPOSITORY,
  reference,
  repoGit,
  shaOf,
  temp,
  treeOf,
} from './proof-test-support'

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
      'a non-reference world bound to the candidate ahead of an unbound reference',
      detection((_r, m) => {
        const world = reference(m)
        const bound: Record<string, unknown> = JSON.parse(world.provenance)
        m.evidenceContext.worlds.unshift({ id: 'stand-in', provenance: JSON.stringify({ ...bound, role: 'target' }) })
        world.provenance = JSON.stringify({ ...bound, commit: OTHER })
      }),
      'unbound',
      /reference world is 2222/,
    ],
    [
      'a replay that is not valid',
      detection((r) => (r.native.replay.stdout = '{"valid":false}')),
      'unreadable',
      /replay valid/,
    ],
    [
      'a replay that is valid but not schema-valid',
      detection((r) => {
        const flags = JSON.parse(r.native.replay.stdout)
        r.native.replay.stdout = JSON.stringify({ ...flags, schemaValid: false })
      }),
      'unreadable',
      /replay valid/,
    ],
    ['a replay that exited non-zero', detection((r) => (r.native.replay.exit = 1)), 'unreadable', /replay valid/],
    ...(['decisionDigestValid', 'artifactDigestValid', 'decisionSemanticsValid'] as const).map(
      (flag) =>
        [
          `a replay whose ${flag} alone is false`,
          detection((r) => {
            const flags = JSON.parse(r.native.replay.stdout)
            r.native.replay.stdout = JSON.stringify({ ...flags, [flag]: false })
          }),
          'unreadable',
          /replay valid/,
        ] as const,
    ),
    [
      'a selected candidate that is not ELIGIBLE',
      detection((_r, m) => {
        for (const candidate of m.candidates)
          if (m.decision.selectedCandidateIds.includes(candidate.id)) candidate.status = 'INELIGIBLE'
      }),
      'verdict',
      /no detection/,
    ],
    ['another PR', detection((r) => (r.invocation.pr = 21)), 'unbound', /pr 21 ≠ 20/],
    [
      'a decision that is not VERIFIED (a miss)',
      detection((_r, m) => (m.decision.status = 'NOT_VERIFIED')),
      'verdict',
      /no detection .*NOT_VERIFIED/,
    ],
    [
      'a VERIFIED decision that selects no candidate',
      detection((_r, m) => (m.decision.selectedCandidateIds = [])),
      'verdict',
      /no detection .*\(miss: VERIFIED\)/,
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

describe('admitLanding', () => {
  const BODY = 'Closes #5\n'
  const semantic: ProofSemanticContext = {
    mode: 'standalone',
    discoveredSpec: { reference: '#5', body: 'lands\n', digest: 'ab'.repeat(32) },
  }
  const canon = hashReviewInput(
    REPOSITORY,
    { pr: 5, candidate: C },
    { body: BODY, lastEditedAt: null },
    null,
    null,
    semantic,
  )
  const gh = async (_cwd: string, args: string[]) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: REPOSITORY })
    if (args.includes('graphql') && args.some((arg) => arg.includes('lastEditedAt')))
      return JSON.stringify({ data: { repository: { pullRequest: { body: BODY, lastEditedAt: null } } } })
    throw new Error(`unexpected GitHub call: ${args.join(' ')}`)
  }

  it('genuine absence with no adapter admits the current canon without a producer', async () => {
    const toplevel = temp()
    expect(
      await admitLanding(
        toplevel,
        { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: canon },
        { gh, git: repoGit({ toplevel }), semantic },
      ),
    ).toEqual({ ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } })
  })

  it.each([
    ['candidate', { tree: [{ path: 'scripts/kit/assertledger/vitest-adapter.mjs' }] }],
    ['base', { baseTree: [{ path: 'scripts/kit/assertledger/vitest-adapter.mjs' }] }],
    [
      'candidate after deleting the base declaration',
      { tree: [], baseTree: [{ path: 'scripts/kit/assertledger/vitest-adapter.mjs' }] },
    ],
  ])('a Kit-only %s admits the current canon without a producer', async (_label, repo) => {
    const toplevel = temp()
    expect(
      await admitLanding(
        toplevel,
        { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: canon },
        { gh, git: repoGit({ toplevel, ...repo }), semantic },
      ),
    ).toEqual({ ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } })
  })

  it.each(['base', 'candidate'] as const)(
    'a %s config alongside Kit still refuses a missing detection',
    async (side) => {
      const toplevel = temp()
      const oid = 'a'.repeat(40)
      const config = { path: 'assertledger.config.json', oid }
      const kit = { path: 'scripts/kit/assertledger/vitest-adapter.mjs' }
      const git = repoGit({
        toplevel,
        tree: side === 'candidate' ? [kit, config] : [kit],
        baseTree: side === 'base' ? [kit, config] : [kit],
        blobs: { [oid]: ASSERTLEDGER_CONFIG },
      })
      const scopedGh = async (_cwd: string, args: string[]) =>
        args[0] === 'api' && args[1] === 'user'
          ? ME
          : args[0] === 'api' && args[1]?.includes('/comments?')
            ? '[]'
            : args.includes('graphql')
              ? JSON.stringify({
                  data: {
                    repository: {
                      pullRequest: {
                        headRefName: 'fix/5-ledger',
                        closingIssuesReferences: {
                          totalCount: 1,
                          nodes: [
                            {
                              number: 5,
                              title: 'fix: ledger',
                              labels: { totalCount: 0, nodes: [] },
                              issueType: { name: 'Fix' },
                            },
                          ],
                        },
                      },
                    },
                  },
                })
              : JSON.stringify({ nameWithOwner: REPOSITORY })
      expect(
        await admitLanding(
          toplevel,
          { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: null },
          { gh: scopedGh, git },
        ),
      ).toMatchObject({ ok: false, producer: 'assertledger', reason: 'missing' })
    },
  )

  it('genuine absence refuses an approval whose review input is not the current canon', async () => {
    const toplevel = temp()
    expect(
      await admitLanding(
        toplevel,
        { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: 'a'.repeat(64) },
        { gh, git: repoGit({ toplevel }), semantic },
      ),
    ).toMatchObject({ ok: false, producer: 'candidate', reason: 'unbound' })
  })

  it.each([
    ['candidate config declares no adapter', '{"framework":"node:test"}', 'candidate', { reason: 'ambiguous' }],
    ['base config is not JSON', '{', 'base', { reason: 'unreadable' }],
  ])('an assertledger config that %s refuses before any ticket read', async (_label, text, side, expected) => {
    const toplevel = temp()
    const oid = 'a'.repeat(40)
    const config = { path: 'assertledger.config.json', oid }
    const git = repoGit({
      toplevel,
      tree: side === 'candidate' ? [config] : [],
      baseTree: side === 'base' ? [config] : [],
      blobs: { [oid]: text },
    })
    const scopedGh = async (_cwd: string, args: string[]) => {
      if (args.includes('graphql')) throw new Error('the ticket was read')
      return JSON.stringify({ nameWithOwner: REPOSITORY })
    }
    expect(
      await admitLanding(
        toplevel,
        { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: null },
        { gh: scopedGh, git },
      ),
    ).toMatchObject({ ok: false, producer: 'assertledger', ...expected })
  })

  it.each([
    ['a truncated closing-issue list throws rather than deciding on part of it', 26],
    ['a complete one decides', 25],
  ])('%s', async (_label, totalCount) => {
    const toplevel = temp()
    const git = repoGit({ toplevel, ...assertledgerConfig() })
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      number: i + 1,
      title: 'feat: more',
      labels: { totalCount: 0, nodes: [] },
      issueType: { name: 'feat' },
    }))
    const scopedGh = async (_cwd: string, args: string[]) => {
      if (args.includes('graphql') && args.some((arg) => arg.includes('lastEditedAt')))
        return JSON.stringify({ data: { repository: { pullRequest: { body: BODY, lastEditedAt: null } } } })
      if (args.includes('graphql'))
        return JSON.stringify({
          data: {
            repository: { pullRequest: { headRefName: 'feat/5-more', closingIssuesReferences: { totalCount, nodes } } },
          },
        })
      return JSON.stringify({ nameWithOwner: REPOSITORY })
    }
    const admitted = admitLanding(
      toplevel,
      { pr: 5, candidate: C, base: 'main', baseTip: BASE_TIP, reviewedAt: null, reviewInput: canon },
      { gh: scopedGh, git, semantic },
    )
    if (totalCount === nodes.length)
      expect(await admitted).toEqual({ ok: true, proof: { semctx: 'absent', assertledger: 'not-applicable' } })
    else await expect(admitted).rejects.toThrow(/closing issues of PR #5 could not be read/)
  })
})
