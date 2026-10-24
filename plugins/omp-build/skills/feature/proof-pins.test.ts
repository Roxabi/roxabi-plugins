/**
 * Proof-config pins are Git identities, not a checkout opinion.
 * A missing path is explicit absence; a tree or unreadable object is not.
 * Drift against the approved pin refuses, including when the checkout is unconfigured.
 */
import { describe, expect, it } from 'vitest'
import {
  ASSERTLEDGER_CONFIG,
  CONFIG,
  type Git,
  type GitResult,
  PROOF_CONFIG_PATHS,
  type ProofConfigPin,
  STACK,
} from './proof-base'
import type { CandidateFacts } from './proof-candidate'
import { compareApplicableProofPins, readProofConfigPins, rereadProofConfigPins } from './proof-pins'

const COMMIT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const BLOB = 'cccccccccccccccccccccccccccccccccccccccc'
const ALT = 'dddddddddddddddddddddddddddddddddddddddd'
const BASE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const HEAD = 'ffffffffffffffffffffffffffffffffffffffff'

type Blob = string | null | 'tree'

function pinGit(blobs: Record<string, Blob>, seen: string[] = []): Git {
  return async (_cwd, args): Promise<GitResult> => {
    seen.push(args.join(' '))
    if (args[0] !== 'ls-tree' || args[1] !== '-z') {
      return { code: 1, stdout: '', stderr: `unexpected git ${args.join(' ')}` }
    }
    const spec = args[2] ?? ''
    const commit = spec.replace('^{commit}', '')
    const path = args[4]
    if (!path || args.includes('status') || args.includes('show')) {
      return { code: 1, stdout: '', stderr: 'pins must not read the working tree' }
    }
    const value = blobs[`${commit}:${path}`]
    if (value === undefined || value === null) return { code: 0, stdout: '', stderr: '' }
    if (value === 'tree') return { code: 0, stdout: `040000 tree ${BLOB}\t${path}\0`, stderr: '' }
    return { code: 0, stdout: `100644 blob ${value}\t${path}\0`, stderr: '' }
  }
}

function facts(overrides: Partial<CandidateFacts> = {}): CandidateFacts {
  return {
    toplevel: '/repo',
    baseTip: BASE,
    candidate: HEAD,
    semctx: 'absent',
    config: null,
    stacks: [],
    adapters: [],
    changeFiles: [],
    ...overrides,
  } as CandidateFacts
}

function pins(
  commit: string,
  blobs: Partial<Record<(typeof PROOF_CONFIG_PATHS)[number], string | null>>,
): ProofConfigPin[] {
  return PROOF_CONFIG_PATHS.map((path) => ({ path, sourceCommit: commit, blob: blobs[path] ?? null }))
}

describe('proof configuration pins', () => {
  it('records a missing path as explicit absence and a regular file as its blob', async () => {
    const git = pinGit({ [`${COMMIT}:${CONFIG}`]: BLOB })
    const read = await readProofConfigPins(git, '/repo', COMMIT, [CONFIG, STACK])
    expect(read).toEqual([
      { path: CONFIG, sourceCommit: COMMIT, blob: BLOB },
      { path: STACK, sourceCommit: COMMIT, blob: null },
    ])
  })

  it('refuses a tree instead of treating it as absence', async () => {
    const git = pinGit({ [`${COMMIT}:${CONFIG}`]: 'tree' })
    const read = await readProofConfigPins(git, '/repo', COMMIT, [CONFIG])
    expect(read).toMatchObject({ ok: false, producer: 'semctx', reason: 'ambiguous' })
  })

  it('refuses an empty pin set and a path that is not a proof-config path', async () => {
    const git = pinGit({})
    expect(await readProofConfigPins(git, '/repo', COMMIT, [])).toMatchObject({ ok: false, reason: 'missing' })
    expect(await readProofConfigPins(git, '/repo', COMMIT, ['../.semctx/config.json'])).toMatchObject({
      ok: false,
      reason: 'unreadable',
    })
  })

  it('re-reads the approved commit and refuses a blob that no longer matches', async () => {
    const git = pinGit({ [`${OTHER}:${CONFIG}`]: ALT })
    const drifted = await rereadProofConfigPins(git, '/repo', [{ path: CONFIG, sourceCommit: OTHER, blob: BLOB }])
    expect(drifted).toMatchObject({ ok: false, reason: 'unbound' })
    const absent = await rereadProofConfigPins(git, '/repo', [])
    expect(absent).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('refuses an omitted required path rather than treating omission as unconfigured', async () => {
    const git = pinGit({})
    const compared = await compareApplicableProofPins(git, facts(), [
      { path: CONFIG, sourceCommit: COMMIT, blob: null },
    ])
    expect(compared).toMatchObject({ ok: false, reason: 'missing' })
  })

  it('refuses a present pin when the checkout has no config, and an absent pin when the candidate commits one', async () => {
    const present = pins(COMMIT, { [CONFIG]: BLOB })
    const missingCheckout = pinGit({ [`${COMMIT}:${CONFIG}`]: BLOB })
    const gone = await compareApplicableProofPins(missingCheckout, facts(), present)
    expect(gone).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })

    const committed = pinGit({
      [`${COMMIT}:${CONFIG}`]: null,
      [`${HEAD}:${CONFIG}`]: BLOB,
    })
    const absorbed = await compareApplicableProofPins(
      committed,
      facts({
        semctx: 'configured',
        config: { source: 'committed', path: CONFIG, text: '{}', sha256: 'ab'.repeat(32) },
      }),
      pins(COMMIT, {}),
    )
    expect(absorbed).toMatchObject({ ok: false, producer: 'semctx', reason: 'unbound' })
  })

  it('accepts matching base and candidate blobs and refuses a candidate that diverges from the pin', async () => {
    const approved = pins(COMMIT, { [CONFIG]: BLOB, [STACK]: ALT, [ASSERTLEDGER_CONFIG]: null })
    const store: Record<string, Blob> = { [`${COMMIT}:${CONFIG}`]: BLOB, [`${COMMIT}:${STACK}`]: ALT }
    for (const path of [CONFIG, STACK] as const) {
      store[`${BASE}:${path}`] = path === CONFIG ? BLOB : ALT
      store[`${HEAD}:${path}`] = path === CONFIG ? BLOB : ALT
    }
    const matched = await compareApplicableProofPins(
      pinGit(store),
      facts({
        semctx: 'configured',
        config: { source: 'committed', path: CONFIG, text: '{}', sha256: 'ab'.repeat(32) },
        stacks: [{ at: HEAD, entry: { mode: '100644', type: 'blob', oid: ALT, path: STACK } }],
      }),
      approved,
    )
    expect(matched).toEqual({ ok: true })

    store[`${HEAD}:${CONFIG}`] = ALT
    const drifted = await compareApplicableProofPins(
      pinGit(store),
      facts({
        semctx: 'configured',
        config: { source: 'committed', path: CONFIG, text: '{}', sha256: 'cd'.repeat(32) },
      }),
      approved,
    )
    expect(drifted).toMatchObject({ ok: false, reason: 'unbound' })
  })

  it('pins landing stack to the base tip and allows a divergent candidate stack', async () => {
    const approved = pins(COMMIT, { [CONFIG]: null, [STACK]: ALT, [ASSERTLEDGER_CONFIG]: null })
    const store: Record<string, Blob> = {
      [`${COMMIT}:${STACK}`]: ALT,
      [`${BASE}:${STACK}`]: ALT,
      [`${HEAD}:${STACK}`]: BLOB,
    }
    const allowed = await compareApplicableProofPins(
      pinGit(store),
      facts({
        stacks: [
          { at: BASE, entry: { mode: '100644', type: 'blob', oid: ALT, path: STACK } },
          { at: HEAD, entry: { mode: '100644', type: 'blob', oid: BLOB, path: STACK } },
        ],
      }),
      approved,
    )
    expect(allowed).toEqual({ ok: true })

    store[`${BASE}:${STACK}`] = BLOB
    const baseDrifted = await compareApplicableProofPins(
      pinGit(store),
      facts({
        stacks: [
          { at: BASE, entry: { mode: '100644', type: 'blob', oid: BLOB, path: STACK } },
          { at: HEAD, entry: { mode: '100644', type: 'blob', oid: BLOB, path: STACK } },
        ],
      }),
      approved,
    )
    expect(baseDrifted).toMatchObject({ ok: false, producer: 'candidate', reason: 'unbound' })
  })

  it('does not ask git for status or ignored files', async () => {
    const seen: string[] = []
    const git = pinGit(
      { [`${COMMIT}:${CONFIG}`]: BLOB, [`${COMMIT}:${STACK}`]: null, [`${COMMIT}:${ASSERTLEDGER_CONFIG}`]: null },
      seen,
    )
    await readProofConfigPins(git, '/repo', COMMIT)
    expect(seen.every((args) => args.startsWith('ls-tree -z ') && !args.includes('status'))).toBe(true)
  })
})
