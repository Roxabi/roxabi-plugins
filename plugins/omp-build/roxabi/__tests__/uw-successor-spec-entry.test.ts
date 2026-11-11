import { describe, expect, it, vi } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { FeatureAuthority } from '../feature-continuation-admission.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { setup, statement, time, uw } from './uw-successor-spec-entry-support.ts'

describe('explicit successor selection', () => {
  it.each(['abandoned', 'revoked'] as const)(
    'refuses a nonconformant %s successor before writes, receipts or checkout',
    async (reason) => {
      const subject = setup(true)
      const read = await subject.read(uw)
      const gh = vi.fn(async (_cwd: string, args: string[]) => {
        if (args[0] === 'issue' && args[1] === 'view')
          return JSON.stringify({ title: 'Legacy UW', body: '', labels: [], updatedAt: time })
        throw new Error(`Unexpected GitHub effect: ${args.join(' ')}`)
      })
      const git = vi.fn()
      const authority = {
        scope: uw,
        selection: { status: 'refused', reason },
        context: { cwd: '/fixture', gh, git },
        identity: { ok: false },
        target: { status: 'issue' },
      } as unknown as FeatureAuthority
      const result = await selectFeatureMandate('new', undefined, authority, subject.operations, {
        readUw: async () => read,
      })
      expect(result).toEqual({
        kind: 'blocked',
        reason: 'successor-spec-nonconformant',
        diagnostics: read.parsed.diagnostics,
      })
      expect(subject.counts()).toEqual({ confirmations: 0, patches: 0 })
      expect(git).not.toHaveBeenCalled()
    },
  )

  it('keeps confirmed generic conservation for an active mandate', async () => {
    const subject = setup(false)
    const before = await subject.read(uw)
    expect(before.accepted.status).toBe('accepted')
    expect(subject.parsed.status).toBe('legacy')
    expect(await subject.operations.prepare(subject.request)).toMatchObject({ ok: true })
    expect(await subject.operations.write(subject.request)).toMatchObject({ status: 'written' })
    expect(subject.counts()).toEqual({ confirmations: 1, patches: 1 })
    const after = parseIssueSpecBody({ uw, raw: rawSource(uw.target, subject.body(), time) })
    expect(after.status).toBe('conformant')
    if (after.status !== 'conformant') throw new Error('expected conformant Spec')
    expect(after.snapshot.spec.criteria).toEqual([{ id: 'C1', statement }])
  })
})
