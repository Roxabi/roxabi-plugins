import { describe, expect, it, vi } from 'vitest'
import { parseIssueSpecBody, rawSource } from '../../adapters/github-native/uw-spec.ts'
import type { FeatureAuthority } from '../feature-continuation-admission.ts'
import { selectFeatureMandate } from '../feature-continuation-selection.ts'
import { specEntrySelection } from '../feature-selection-spec-entry.ts'
import { setup, statement, time, uw } from './uw-successor-spec-entry-support.ts'

const successor = vi.hoisted(() => vi.fn())
vi.mock('../feature-selection-successor.ts', () => ({ createSuccessorSelection: successor }))

vi.mock('../uw-spec', () => ({
  readSelectionIssueSpec: async () => ({ title: 'Legacy UW', body: '', labels: [], updatedAt: time }),
}))

describe('explicit successor selection', () => {
  it.each(['abandoned', 'revoked'] as const)(
    'refuses a nonconformant %s successor before writes, receipts or checkout',
    async (reason) => {
      const subject = setup(true)
      const read = await subject.read(uw)
      successor.mockReset()
      const gh = vi.fn()
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
      expect(gh).not.toHaveBeenCalled()
      expect(successor).not.toHaveBeenCalled()
      expect(git).not.toHaveBeenCalled()
    },
  )

  it.each(['abandoned', 'revoked'] as const)(
    'routes a conformant %s successor to the normal successor path',
    async (reason) => {
      const subject = setup(true)
      const read = await subject.read(uw)
      const selection = { status: 'refused', reason } as FeatureAuthority['selection']
      const conformant = { ...read, parsed: subject.original }
      expect(specEntrySelection('new', { scope: uw, selection }, conformant)).toBeNull()
      const authority = {
        scope: uw,
        selection,
        context: { cwd: '/fixture', gh: vi.fn(), git: vi.fn() },
        identity: { ok: false },
        target: { status: 'issue' },
        history: subject.history,
        parentHistories: [],
        causal: {},
      } as unknown as FeatureAuthority
      successor.mockReset()
      successor.mockResolvedValue({ kind: 'blocked', reason: 'successor-test-stop' })
      expect(
        await selectFeatureMandate('new', undefined, authority, subject.operations, { readUw: async () => conformant }),
      ).toEqual({ kind: 'blocked', reason: 'successor-test-stop' })
      expect(successor).toHaveBeenCalledOnce()
      expect(successor).toHaveBeenCalledWith(expect.objectContaining({ authority, uwRead: conformant }))
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
