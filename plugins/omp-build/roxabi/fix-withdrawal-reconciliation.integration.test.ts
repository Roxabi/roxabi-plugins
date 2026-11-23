import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ObservedComment } from '../engine/review-schema.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { observedComment } from '../testing/record-history.ts'
import { roxabiRecordFixtures } from '../testing/roxabi-presets.ts'
import { reconcileWithdrawalHistories } from './fix-uw-histories.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const otherScope = { repository: 'acme/app', target: 'acme/app#43' }

function barrier(id: number, previous: number | null = null): WithdrawalBarrier {
  const record = {
    version: 1,
    kind: 'withdraw',
    operationId: `withdraw-${id}`,
    repositoryId: 100,
    pullRequestId: 200,
    pullRequest: 42,
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    lane: 'all',
    source: 'revoke',
    previous,
    evidence: 'stop',
  }
  return {
    id,
    body: `<!-- kit-head-authorization:v1 -->\n${JSON.stringify(record)}`,
    createdAt: `2026-10-21T10:00:${id === 901 ? '01' : '02'}Z`,
    record,
  }
}

function comment(receipt: WithdrawalBarrier): ObservedComment {
  return observedComment({
    locator: `comment-${receipt.id}`,
    nativeId: String(receipt.id),
    body: receipt.body,
    createdAt: receipt.createdAt,
  })
}

function fixture() {
  const original = roxabiRecordFixtures().encodedAdmissionReviewGraph({ scope }).history
  const other = decodeHistory({ ...original.source, scope: otherScope, comments: [] })
  return { original, other }
}

function appended(history: DecodedHistory, comments: ObservedComment[]): DecodedHistory {
  return decodeHistory({ ...history.source, comments: [...history.source.comments, ...comments] })
}

function compare(before: DecodedHistory[], after: DecodedHistory[], barriers: WithdrawalBarrier[]) {
  return reconcileWithdrawalHistories(before, after, scope, barriers)
}

describe('withdrawal receipt reconciliation', () => {
  it('retains the fresh native history after exactly the confirmed own append', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const fresh = appended(original, [comment(receipt)])
    const result = compare([original, other], [fresh, other], [receipt])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual([fresh, other])
  })

  it('reconciles sequential distinct confirmed writes only in observed publication order', () => {
    const { original, other } = fixture()
    const first = barrier(901)
    const second = barrier(902, 901)
    const fresh = appended(original, [comment(first), comment(second)])
    expect(compare([original, other], [fresh, other], [first, second]).ok).toBe(true)
    expect(compare([original, other], [fresh, other], [second, first]).ok).toBe(false)
    expect(
      compare([original, other], [appended(original, [comment(second), comment(first)]), other], [first, second]).ok,
    ).toBe(false)
  })

  it.each(['id', 'body', 'createdAt', 'kind', 'pullRequest'] as const)(
    'refuses a receipt that does not authenticate the observed %s',
    (field) => {
      const { original, other } = fixture()
      const receipt = barrier(901)
      const fresh = appended(original, [comment(receipt)])
      const wrong: WithdrawalBarrier =
        field === 'id'
          ? { ...receipt, id: 999 }
          : field === 'body'
            ? { ...receipt, body: `${receipt.body} ` }
            : field === 'createdAt'
              ? { ...receipt, createdAt: '2026-10-21T10:01:01Z' }
              : { ...receipt, record: { ...receipt.record, [field]: field === 'kind' ? 'grant' : 43 } }
      expect(compare([original, other], [fresh, other], [wrong]).ok).toBe(false)
    },
  )

  it('refuses missing or unconfirmed receipts, including protocol-shaped foreign comments', () => {
    const { original, other } = fixture()
    const own = barrier(901)
    const foreign = barrier(902)
    expect(compare([original, other], [original, other], [own]).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(own)]), other], []).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(foreign)]), other], [own]).ok).toBe(false)
    expect(compare([original, other], [appended(original, [comment(own), comment(foreign)]), other], [own]).ok).toBe(
      false,
    )
    expect(compare([original, other], [appended(original, [comment(foreign), comment(own)]), other], [own]).ok).toBe(
      false,
    )
  })

  it('refuses edits, deletion, and native identity changes to preceding comments', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const prior = original.source.comments[0]
    if (!prior) throw new Error('expected native review comment')
    for (const changed of [
      { ...prior, body: `${prior.body} edited` },
      { ...prior, nativeId: '999' },
      { ...prior, locator: 'different-native-locator' },
    ]) {
      const altered = {
        ...original,
        source: { ...original.source, comments: [changed, ...original.source.comments.slice(1)] },
      }
      expect(compare([original, other], [appended(altered, [comment(receipt)]), other], [receipt]).ok).toBe(false)
    }
    const deleted = { ...original, source: { ...original.source, comments: original.source.comments.slice(1) } }
    expect(compare([original, other], [appended(deleted, [comment(receipt)]), other], [receipt]).ok).toBe(false)
  })

  it('refuses drift in other scopes, decoded evidence, completeness, or scope membership', () => {
    const { original, other } = fixture()
    const receipt = barrier(901)
    const fresh = appended(original, [comment(receipt)])
    const changedOperations = { ...fresh, operations: fresh.operations.slice(1) }
    expect(compare([original, other], [changedOperations, other], [receipt]).ok).toBe(false)
    const changedEvidence = {
      ...fresh,
      diagnostics: [...fresh.diagnostics, { code: 'changed', message: 'new evidence' }],
    }
    const changedOther = { ...other, source: { ...other.source, comments: [observedComment()] } }
    const incomplete = { ...fresh, source: { ...fresh.source, complete: false } }
    expect(compare([original, other], [changedEvidence, other], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh, changedOther], [receipt]).ok).toBe(false)
    expect(compare([original, other], [incomplete, other], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh], [receipt]).ok).toBe(false)
    expect(compare([original, other], [fresh, fresh], [receipt]).ok).toBe(false)
    expect(compare([other], [other], [receipt]).ok).toBe(false)
  })
})
