import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { observeHistoricalPins } from '../adapters/github/historical-pins.ts'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { buildDeliveredLeaf } from '../engine/__tests__/uw-delivered-leaf-fixture.ts'
import type { MissingContextOutput } from '../engine/action-context.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs, PinnedFileRef } from '../engine/action-input-schema.ts'
import { authenticateHistoricalActionInputs } from '../engine/historical-action-inputs.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { reviewContextLineage } from '../engine/review-context-lineage.ts'
import { fixtureCatalogueGhResponse, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, reviewRoot, submission, TEST_SCOPE } from '../testing/record-builders.ts'
import { contribution, finalReview } from '../testing/record-decisions.ts'
import { historicalRecordFrames, observedComment } from '../testing/record-history.ts'

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
const files = {
  'region.txt': 'Deploy to the primary region.\n',
  'policy.txt': 'Require a separate policy review.\n',
  'one.txt': 'One context expansion.\n',
  'two.txt': 'A competing context expansion.\n',
}
const workingRegion = 'Uncommitted region instructions.\n'
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')
let cwd: string
let commit: string

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), 'omp-review-context-lineage-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('remote', 'add', 'origin', `https://github.com/${TEST_SCOPE.repository}.git`)
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(cwd, path), bytes)
  git('add', '--', ...Object.keys(files))
  git('-c', 'user.name=Review Lineage', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Seed review context')
  commit = git('rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'region.txt'), workingRegion)
})

afterAll(() => rmSync(cwd, { recursive: true, force: true }))

function pin(path: keyof typeof files): PinnedFileRef {
  return { source: 'git-file', repository: TEST_SCOPE.repository, commit, path, digest: digest(files[path]) }
}

function observe(decoded: DecodedHistory) {
  return observeHistoricalPins(decoded, {
    cwd,
    readAuthor: NATIVE_AUTHOR,
    gh: async (_cwd, args) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      throw new Error('Fixture has no other remote Git objects')
    },
  })
}

const negative: MissingContextOutput = {
  outcome: 'missing-context',
  missing: [
    { locator: { kind: 'information-request', description: 'deployment region' }, reason: 'not supplied', targets: [] },
  ],
}

function history(records: CanonicalRecord[]) {
  const comments = records.flatMap((record) =>
    historicalRecordFrames(record).map((body) =>
      observedComment({ locator: `comment-${record.recordId}`, nativeId: record.recordId, body }),
    ),
  )
  return decodeHistory({
    scope: TEST_SCOPE,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments,
  })
}

function expanded(
  inputs: ActionInputs,
  entry: Contribution,
  addedContext: ActionInputs['manifest']['expandedContext'][number],
): ActionInputs {
  const manifest = {
    ...inputs.manifest,
    expandedContext: [
      ...inputs.manifest.expandedContext,
      {
        source: 'record' as const,
        record: { scope: TEST_SCOPE, kind: 'contribution' as const, recordId: entry.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(entry.payload),
      },
      addedContext,
    ],
  }
  return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
}

function historicalReview(inputs: ActionInputs, id: string, data: typeof negative | { findings: never[] }) {
  const slotId = 'panel-0'
  const action = { actionId: `${id}:${slotId}`, inputs }
  const root = reviewRoot({
    id: `review-${id}`,
    head: inputs.manifest.code.head,
    inputSnapshot: inputs,
    tier: 'F-lite',
    slots: [
      {
        slotId,
        phase: 'panel',
        role: 'R-adversarial',
        chunk: 0,
        required: true,
        output: 'findings',
        classId: null,
        sourceFindingIds: [],
        action,
      },
    ],
  })
  const entry = contribution({
    id: `contribution-${id}`,
    inventoryId: root.recordId,
    slotId,
    structured: data,
    findings: 'outcome' in data ? null : data.findings,
    rawAttempts: [submission({ structuredOutput: { data } })],
  })
  if ('outcome' in data) entry.payload.host.action = action
  return { root, entry }
}

async function lineage(records: CanonicalRecord[]) {
  const decoded = await observe(history(records))
  return reviewContextLineage(decoded, new Map(records.map((record) => [record.recordId, record])))
}

describe('authenticated review context lineage', () => {
  it('accepts a linear negative A → negative B → positive C while preserving both negative refs', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'a', negative)
    const bInputs = expanded(inputs, a.entry, pin('region.txt'))
    const b = historicalReview(bInputs, 'b', negative)
    const cInputs = expanded(bInputs, b.entry, pin('policy.txt'))
    const c = historicalReview(cInputs, 'c', { findings: [] })
    expect(
      cInputs.manifest.expandedContext.filter((ref) => ref.source === 'record').map((ref) => ref.record.recordId),
    ).toEqual([a.entry.recordId, b.entry.recordId])
    const result = await lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry])
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set([a.root.recordId, b.root.recordId]))
  })

  it('does not supersede a negative using another selector into that contribution', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'same-record-a', negative)
    const bInputs = expanded(inputs, a.entry, {
      source: 'record',
      record: { scope: TEST_SCOPE, kind: 'contribution', recordId: a.entry.recordId },
      selector: '/payload/findings',
      digest: canonicalValueDigest(a.entry.payload.findings),
    })
    const b = historicalReview(bInputs, 'same-record-b', { findings: [] })
    const records = [a.root, a.entry, b.root, b.entry]
    const observed = await observe(history(records))
    expect(authenticateHistoricalActionInputs(bInputs, [observed]).ok).toBe(true)
    const result = reviewContextLineage(observed, new Map(records.map((record) => [record.recordId, record])))
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set())
  })

  it('does not supersede a negative by re-listing an authenticated plugin file', async () => {
    const base = standaloneReviewInputs(TEST_SCOPE, commit)
    const prior = pin('region.txt')
    const manifest = {
      ...base.manifest,
      plugin: { ...base.manifest.plugin, repository: prior.repository, commit, files: [prior] },
    }
    const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
    const a = historicalReview(inputs, 'prior-plugin-a', negative)
    const bInputs = expanded(inputs, a.entry, prior)
    const b = historicalReview(bInputs, 'prior-plugin-b', { findings: [] })
    const records = [a.root, a.entry, b.root, b.entry]
    const observed = await observe(history(records))
    expect(authenticateHistoricalActionInputs(bInputs, [observed]).ok).toBe(true)
    expect(
      reviewContextLineage(observed, new Map(records.map((record) => [record.recordId, record]))).superseded,
    ).toEqual(new Set())
  })

  it('does not supersede a negative by re-listing an authenticated delivery declaration without its role', async () => {
    const leaf = await buildDeliveredLeaf()
    const declaration = leaf.inputs.manifest.deliveryData[0]
    if (declaration === undefined) throw new Error('Expected a captured implementation declaration')
    const { role: _role, ...prior } = declaration
    const base = standaloneReviewInputs(TEST_SCOPE, commit)
    const manifest = { ...base.manifest, deliveryData: [declaration] }
    const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
    const a = historicalReview(inputs, 'prior-declaration-a', negative)
    const bInputs = expanded(inputs, a.entry, prior)
    const b = historicalReview(bInputs, 'prior-declaration-b', { findings: [] })
    const records = [a.root, a.entry, b.root, b.entry]
    const observed = await observe(history(records))
    const histories = [observed, ...leaf.observation.histories]
    expect(authenticateHistoricalActionInputs(bInputs, histories).ok).toBe(true)
    const result = reviewContextLineage(
      observed,
      new Map(records.map((record) => [record.recordId, record])),
      histories,
    )
    expect(result.superseded).toEqual(new Set())
  })

  it('continues authenticated context expansion despite a foreign copied contribution identity', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'collision-a', negative)
    const bInputs = expanded(inputs, a.entry, pin('region.txt'))
    const b = historicalReview(bInputs, 'collision-b', { findings: [] })
    const records = [a.root, a.entry, b.root, b.entry]
    const byId = new Map(records.map((record) => [record.recordId, record]))
    const authentic = history(records)
    const foreign = observedComment({
      locator: 'foreign-collision',
      nativeId: 'foreign-collision',
      author: 'stranger',
      body: `<!-- omp-build-record v=1 kind=contribution id=${a.entry.recordId} operationId=${a.entry.operationId} part=1/2 data=e30 -->`,
    })
    const noisy = decodeHistory({ ...authentic.source, comments: [...authentic.source.comments, foreign] })
    expect(noisy.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ authority: 'foreign', operationId: a.entry.operationId })]),
    )
    const result = reviewContextLineage(await observe(noisy), byId)
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set([a.root.recordId]))
    const edited = decodeHistory({
      ...authentic.source,
      comments: authentic.source.comments.map((comment) =>
        comment.locator === `comment-${a.entry.recordId}` ? { ...comment, updatedAt: '2026-10-21T10:00:01Z' } : comment,
      ),
    })
    expect(edited.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'record-edited' })]))
    expect(reviewContextLineage(await observe(edited), byId).superseded).toEqual(new Set())
  })

  it('refuses a late final on a negative root even after a successor exists', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'late-a', negative)
    const b = historicalReview(expanded(inputs, a.entry, pin('region.txt')), 'late-b', negative)
    const records = [a.root, a.entry, b.root, b.entry]
    const late = finalReview({ id: 'late-final', inventoryIds: [a.root.recordId] })
    expect((await lineage([...records, late])).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'incomplete',
          message: expect.stringContaining('cannot produce a final review'),
        }),
      ]),
    )
  })

  it('refuses two distinct children of the same authenticated negative', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'fork-a', negative)
    const b = historicalReview(expanded(inputs, a.entry, pin('one.txt')), 'fork-b', negative)
    const c = historicalReview(expanded(inputs, a.entry, pin('two.txt')), 'fork-c', negative)
    expect((await lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry])).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-reference' })]),
    )
  })

  it('does not supersede a negative using the digest of the working-tree replacement', async () => {
    const inputs = standaloneReviewInputs(TEST_SCOPE, commit)
    const a = historicalReview(inputs, 'wrong-digest-a', negative)
    const wrong = { ...pin('region.txt'), digest: digest(workingRegion) }
    const b = historicalReview(expanded(inputs, a.entry, wrong), 'wrong-digest-b', { findings: [] })
    expect((await lineage([a.root, a.entry, b.root, b.entry])).superseded).toEqual(new Set())
  })
})
