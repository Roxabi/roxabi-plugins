import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HISTORICAL_CASES } from './__fixtures__/proof/historical-cases'
import { historicalSpec } from './__fixtures__/proof/historical-spec'
import { ACQUIRE, sandbox, worktree } from './__fixtures__/proof/sandbox-repository'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { semctxInputs } from './proof-association'
import { candidateFacts } from './proof-candidate'
import type { SemctxRecord } from './proof-semctx-protocol'
import { readSemctxRecord } from './proof-semctx-validation'
import { approve, decodeFixtureProof, HISTORICAL_RECORDS, wireProof } from './testing/proof-integration/data'
import { ME, REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { instrument, prepare, producerCalls } from './testing/proof-integration/setup'

describe('retained historical Semctx admission', () => {
  let box: Box
  const wt: Record<string, string> = {}
  const sha = (branch: string) => box.sha[branch] as string

  function captured(name: keyof typeof HISTORICAL_RECORDS.records): string[] {
    const data = HISTORICAL_RECORDS.records[name].data
    if (data === undefined) throw new Error(`historical ${name} capture has no Semctx native data`)
    // Retain capture provenance (authoritative PR in packet); do not rewrite to separate scope.
    return wireProof(data)
  }

  function prime(name: keyof typeof HISTORICAL_RECORDS.records, body = 'Closes #812\n'): void {
    const { pr, branch } = HISTORICAL_CASES[name]
    prepare(box, pr, { comments: [approve(sha(branch)), ...captured(name)], body })
  }

  /** The same lossless Git seam production uses to derive historical source qualification. */
  async function inputs(name: keyof typeof HISTORICAL_CASES) {
    const root = wt[name]
    const { branch, base } = HISTORICAL_CASES[name]
    const candidate = sha(branch)
    const baseTip = sha(base)
    if (!root) throw new Error(`missing historical worktree ${name}`)
    const realGit = async (cwd: string, args: string[]) => {
      const run = spawnSync('git', args, { cwd, env: box.env, encoding: 'utf8' })
      return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr }
    }
    const facts = await candidateFacts(root, candidate, base, baseTip, realGit)
    if ('ok' in facts) throw new Error(facts.error)
    return semctxInputs(facts, realGit)
  }

  beforeAll(() => {
    box = sandbox(historicalSpec())
    for (const [branch, recorded] of Object.entries(HISTORICAL_RECORDS.sha)) {
      if (box.sha[branch] !== recorded) {
        throw new Error(`${branch} rebuilt as ${box.sha[branch]}, recorded ${recorded}: re-run historical.capture.ts`)
      }
    }
    instrument(box)
    for (const [name, { branch }] of Object.entries(HISTORICAL_CASES))
      wt[name] = worktree(box, `historical-${name}`, sha(branch))
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('admits a current VERIFIED contract beside a qualified superseded history with its flat file-link run reordered', async () => {
    const { pr, branch } = HISTORICAL_CASES.valid
    const expected = await inputs('valid')
    if ('ok' in expected) throw new Error(expected.error)
    expect([...expected.historicalContracts]).toEqual([['.semctx/semantic/changes/change.fx.history.sem', 'author']])
    prime('valid')
    const run = land(box, wt.valid as string, pr)
    expect(run.result).toMatchObject({
      status: 'watching',
      proof: {
        semctx: {
          verdict: 'VERIFIED',
          changes: [
            { id: 'change.fx.current', verdict: 'VERIFIED' },
            { id: 'change.fx.history', verdict: 'VERIFIED' },
          ],
          gaps: [],
        },
      },
    })
    expect(run.gate).toEqual({
      labels: ['reviewed'],
      autoMerge: expect.objectContaining({ matchHeadCommit: sha(branch) }),
    })
    expect(run.producers).toEqual([])
  })

  it('refuses a retained source-qualified history when native inspect reports different provenance', async () => {
    const { pr, branch } = HISTORICAL_CASES.valid
    const expected = await inputs('valid')
    if ('ok' in expected) throw new Error(expected.error)
    const candidate = sha(branch)
    const found = decodeFixtureProof(
      captured('valid').map((body) => ({ author: { login: ME }, body })),
      'semctx',
      candidate,
      pr,
    )
    const record = structuredClone(found.record) as SemctxRecord
    const inspect = record.native.find(
      (step) => step.argv.includes('inspect') && step.argv.includes('change.fx.history'),
    )
    if (!inspect) throw new Error('missing historical native inspect')
    const altered = inspect.stdout.replace('"provenance": "author"', '"provenance": "agent"')
    if (altered === inspect.stdout) throw new Error('historical native inspect has no author provenance')
    inspect.stdout = altered
    expect(
      readSemctxRecord(record, {
        repository: 'acme/app',
        pr,
        candidate,
        ...expected,
        changeFiles: expected.contracts,
      }),
    ).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })
  })

  it('keeps the historical native open unknown PARTIAL until its named NO TEST row is reviewed', () => {
    const { pr } = HISTORICAL_CASES.partial
    prime('partial')
    const missing = land(box, wt.partial as string, pr)
    expect(missing.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'unjustified' })
    expect(missing.gate).toEqual(UNARMED)

    prime(
      'partial',
      'Closes #812\n\n| Gap | Why | Proof |\n|---|---|---|\n| `unknown.fx.old-review` | historic review | ⚠ NO TEST — out-of-scope |\n',
    )
    const admitted = land(box, wt.partial as string, pr)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: {
        semctx: {
          verdict: 'PARTIAL',
          changes: [
            { id: 'change.fx.current', verdict: 'VERIFIED' },
            { id: 'change.fx.history', verdict: 'PARTIAL' },
          ],
          gaps: [{ gap: 'unknown.fx.old-review', reason: 'out-of-scope' }],
        },
      },
    })
    expect([...missing.producers, ...admitted.producers]).toEqual([])
  })

  it('refuses a native BLOCKED historical proof after its source qualifies', () => {
    const { pr } = HISTORICAL_CASES.blocked
    prime('blocked')
    const run = land(box, wt.blocked as string, pr)
    expect(run.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict' })
    expect(run.result.error).toContain('BLOCKED')
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual([])
  })

  it('refuses an own superseded A even when the historical M qualifies', async () => {
    const { pr } = HISTORICAL_CASES.ownSuperseded
    const expected = await inputs('ownSuperseded')
    if ('ok' in expected) throw new Error(expected.error)
    expect(expected.contracts).toEqual([
      '.semctx/semantic/changes/change.fx.current.sem',
      '.semctx/semantic/changes/change.fx.history.sem',
    ])
    expect([...expected.historicalContracts]).toEqual([['.semctx/semantic/changes/change.fx.history.sem', 'author']])
    prime('ownSuperseded')
    const run = land(box, wt.ownSuperseded as string, pr)
    expect(run.result).toMatchObject({ status: 'proof-blocked', producer: 'semctx', reason: 'verdict' })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual([])
  })

  it('rejects provenance borrowed from another block in acquisition and admission', async () => {
    const { pr } = HISTORICAL_CASES.borrowedProvenance
    const expected = await inputs('borrowedProvenance')
    if ('ok' in expected) throw new Error(expected.error)
    prime('borrowedProvenance')
    const acquired = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], {
      cwd: wt.borrowedProvenance,
      env: box.env,
      encoding: 'utf8',
    })
    expect(acquired.status, acquired.stderr).toBe(0)
    const acquisitionProducers = producerCalls(box)
    const run = land(box, wt.borrowedProvenance as string, pr)
    expect({
      contracts: expected.contracts,
      historicalContracts: [...expected.historicalContracts],
      acquisition: JSON.parse(acquired.stdout),
      admission: run.result,
      gate: run.gate,
      producers: [...acquisitionProducers, ...run.producers],
    }).toMatchObject({
      contracts: ['.semctx/semantic/changes/change.fx.current.sem', '.semctx/semantic/changes/change.fx.history.sem'],
      historicalContracts: [],
      acquisition: {
        semctx: 'reused',
        semctxAssessment: { ok: false, producer: 'semctx', reason: 'verdict' },
      },
      admission: { status: 'proof-blocked', producer: 'semctx', reason: 'verdict' },
      gate: UNARMED,
      producers: [],
    })
  })

  it.each([
    ['a substantive statement rewrite', 'statementChanged'],
    ['a flat-link deletion', 'linkRemoved'],
    ['a flat-link replacement', 'linkReplaced'],
    ['a flat-link duplicate-count change', 'linkDuplicated'],
    ['a link move across a comment boundary', 'linkCrossedComment'],
    ['a candidate provenance rewrite', 'provenanceChanged'],
    ['missing explicit base provenance', 'missingBaseProvenance'],
    ['invalid base provenance that native would default', 'invalidBaseProvenance'],
    ['duplicate status spellings in the base', 'duplicateBaseStatus'],
    ['duplicate provenance spellings in the base', 'duplicateBaseProvenance'],
  ] as const)(
    'does not qualify %s as retained history, while keeping its current and modified contracts in the native input',
    async (_label, name) => {
      const expected = await inputs(name)
      if ('ok' in expected) throw new Error(expected.error)
      expect(expected.contracts).toEqual([
        '.semctx/semantic/changes/change.fx.current.sem',
        '.semctx/semantic/changes/change.fx.history.sem',
      ])
      expect([...expected.historicalContracts]).toEqual([])
    },
  )
})
