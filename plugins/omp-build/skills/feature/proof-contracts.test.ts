import { describe, expect, it } from 'vitest'
import type { Git } from './proof-base'
import { justifyGaps } from './proof-justification'
import { type ChangeResult, changedContracts } from './proof-semctx-protocol'
import { C, GAP } from './proof-test-support'

describe('changedContracts', () => {
  const diff =
    (stdout: string): Git =>
    async () => ({ code: 0, stdout, stderr: '' })
  const at = (name: string) => `.semctx/semantic/changes/${name}`
  const MAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('lists the added and modified contracts directly in changes/, by path, and skips other files', async () => {
    const listed = diff(`M\0${at('b.sem')}\0A\0${at('a.sem')}\0A\0${at('notes.md')}\0`)
    expect(await changedContracts(listed, '/repo', MAIN, C)).toEqual([
      { path: at('a.sem'), status: 'A' },
      { path: at('b.sem'), status: 'M' },
    ])
  })

  it.each([
    ['nested under changes/', `A\0${at('sub/x.sem')}\0`, /must sit directly in/],
    ['deleted', `D\0${at('x.sem')}\0`, /status D is not supported/],
    ['retyped', `T\0${at('x.sem')}\0`, /status T is not supported/],
  ])('a contract %s fails closed', async (_label, stdout, error) => {
    const out = await changedContracts(diff(`A\0${at('a.sem')}\0${stdout}`), '/repo', MAIN, C)
    expect(out).toBeInstanceOf(Error)
    expect(String(out)).toMatch(error)
  })
})

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
