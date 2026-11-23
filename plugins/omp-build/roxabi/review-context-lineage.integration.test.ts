import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import type { MissingContextOutput } from '../engine/action-context.ts'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { reviewContextLineage } from '../engine/review-context-lineage.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { committedFixtureInputs } from '../testing/committed-plugin-fixture.ts'
import { NATIVE_AUTHOR, reviewRoot, submission, TEST_HEAD, TEST_SCOPE } from '../testing/record-builders.ts'
import { contribution, finalReview } from '../testing/record-decisions.ts'
import { historicalRecordFrames, observedComment } from '../testing/record-history.ts'
import { toolingGh } from '../testing/review-gate-tooling-gh.ts'
import { readProductionActionFactsBatch } from './uw-action-batch-facts.ts'
import type { UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import * as actionObserve from './uw-action-observe.ts'
import { actionOperationMethods } from './uw-action-operations.ts'
import { sha256Bytes } from './uw-action-result.ts'
import { resolveNegativeContribution } from './uw-context-negative-contribution.ts'
import { createProductionInputPorts } from './uw-input-readers.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
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

function expanded(inputs: ActionInputs, entry: Contribution, path: string): ActionInputs {
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
      {
        source: 'git-file' as const,
        repository: TEST_SCOPE.repository,
        commit: 'b'.repeat(40),
        path,
        digest: canonicalValueDigest(path),
      },
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

function lineage(records: CanonicalRecord[]) {
  const decoded = history(records)
  return reviewContextLineage(decoded, new Map(records.map((record) => [record.recordId, record])))
}

describe('authenticated review context lineage', () => {
  it('accepts a linear negative A → negative B → positive C while preserving both negative refs', () => {
    const a = historicalReview(standaloneReviewInputs(), 'a', negative)
    const bInputs = expanded(standaloneReviewInputs(), a.entry, 'region.txt')
    const b = historicalReview(bInputs, 'b', negative)
    const beforeC = history([a.root, a.entry, b.root, b.entry])
    const cInputs = expanded(bInputs, b.entry, 'policy.txt')
    const c = historicalReview(cInputs, 'c', { findings: [] })
    const request = {
      actionId: 'next-review-action',
      purpose: 'review' as const,
      subject: cInputs.manifest.subject,
      code: cInputs.manifest.code,
      stageSources: cInputs.stageSources,
      expandedContext: cInputs.manifest.expandedContext,
    }
    expect(resolveNegativeContribution(request, [beforeC])).toMatchObject({
      ok: true,
      value: {
        inherited: false,
        inventoryId: b.root.recordId,
        negativeRef: { record: { recordId: b.entry.recordId } },
      },
    })
    expect(
      resolveNegativeContribution({ ...request, actionId: `${c.root.recordId}:synthesis` }, [
        history([a.root, a.entry, b.root, b.entry, c.root, c.entry]),
      ]),
    ).toMatchObject({
      ok: true,
      value: { inherited: true, currentRootAttemptId: c.root.recordId, previous: cInputs },
    })
    expect(
      cInputs.manifest.expandedContext.filter((ref) => ref.source === 'record').map((ref) => ref.record.recordId),
    ).toEqual([a.entry.recordId, b.entry.recordId])
    const result = lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry])
    expect(result.diagnostics).toEqual([])
    expect(result.superseded).toEqual(new Set([a.root.recordId, b.root.recordId]))
  })

  it('continues authenticated context expansion despite a foreign copied contribution identity', () => {
    const inputs = standaloneReviewInputs()
    const a = historicalReview(inputs, 'collision-a', negative)
    const bInputs = expanded(inputs, a.entry, 'region.txt')
    const authentic = history([a.root, a.entry])
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
    const request = {
      actionId: 'expanded-review',
      purpose: 'review' as const,
      subject: bInputs.manifest.subject,
      code: bInputs.manifest.code,
      stageSources: bInputs.stageSources,
      expandedContext: bInputs.manifest.expandedContext,
    }
    expect(resolveNegativeContribution(request, [noisy])).toMatchObject({
      ok: true,
      value: { inventoryId: a.root.recordId, negativeRef: { record: { recordId: a.entry.recordId } } },
    })
    const edited = decodeHistory({
      ...authentic.source,
      comments: authentic.source.comments.map((comment) =>
        comment.locator === `comment-${a.entry.recordId}` ? { ...comment, updatedAt: '2026-10-21T10:00:01Z' } : comment,
      ),
    })
    expect(edited.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'record-edited' })]))
    expect(resolveNegativeContribution(request, [edited])).toEqual({ ok: true, value: null })
  })

  it('treats an authenticated review negative as ordinary context for correction', () => {
    const inputs = standaloneReviewInputs()
    const a = historicalReview(inputs, 'cross-purpose', negative)
    const context = expanded(inputs, a.entry, 'region.txt')
    expect(
      resolveNegativeContribution(
        {
          actionId: 'correction-action',
          purpose: 'correction',
          subject: context.manifest.subject,
          code: context.manifest.code,
          stageSources: context.stageSources,
          expandedContext: context.manifest.expandedContext,
        },
        [history([a.root, a.entry])],
      ),
    ).toEqual({ ok: true, value: null })
  })

  it('refuses a late final on a negative root even after a successor exists', () => {
    const a = historicalReview(standaloneReviewInputs(), 'late-a', negative)
    const b = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'region.txt'), 'late-b', negative)
    const records = [a.root, a.entry, b.root, b.entry]
    const late = finalReview({ id: 'late-final', inventoryIds: [a.root.recordId] })
    expect(lineage([...records, late]).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'incomplete',
          message: expect.stringContaining('cannot produce a final review'),
        }),
      ]),
    )
  })

  it('refuses two distinct children of the same authenticated negative', () => {
    const a = historicalReview(standaloneReviewInputs(), 'fork-a', negative)
    const b = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'one.txt'), 'fork-b', negative)
    const c = historicalReview(expanded(standaloneReviewInputs(), a.entry, 'two.txt'), 'fork-c', negative)
    expect(lineage([a.root, a.entry, b.root, b.entry, c.root, c.entry]).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'duplicate-reference' })]),
    )
  })
})

it('bulk selected records validate each sibling and observe later history changes', async () => {
  const inputs = standaloneReviewInputs()
  const a = historicalReview(inputs, 'bulk-a', negative)
  const b = historicalReview(inputs, 'bulk-b', negative)
  let records: CanonicalRecord[] = [a.root, a.entry, b.entry]
  let foreign = true
  const gh = async () => {
    const comments = records.flatMap((record) => {
      return historicalRecordFrames(record).map((body, index) => ({
        id: `${record.recordId}-${index}`,
        user: { login: record.recordId === b.entry.recordId && foreign ? 'foreign-user' : NATIVE_AUTHOR },
        body,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: record.recordId === b.entry.recordId && !foreign ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z',
      }))
    })
    return JSON.stringify(comments)
  }
  const ports = createProductionInputPorts({ cwd: '/fixture', gh, readAuthor: NATIVE_AUTHOR })
  const ref = {
    source: 'record' as const,
    record: { scope: TEST_SCOPE, kind: 'contribution' as const, recordId: a.entry.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(a.entry.payload),
  }
  expect(await ports.readRecords([ref, ref])).toEqual({ ok: true, value: [a.entry.payload, a.entry.payload] })
  expect((await ports.readRecords([ref, { ...ref, selector: '/unknown' }])).ok).toBe(false)
  expect((await ports.readRecords([ref, { ...ref, digest: '0'.repeat(64) }])).ok).toBe(false)
  const unauthenticated = {
    ...ref,
    record: { ...ref.record, recordId: b.entry.recordId },
    digest: canonicalValueDigest(b.entry.payload),
  }
  expect((await ports.readRecords([ref, unauthenticated])).ok).toBe(false)
  expect((await ports.readAccountedRecord?.(unauthenticated))?.ok).toBe(false)
  foreign = false
  expect((await ports.readRecords([ref, unauthenticated])).ok).toBe(false)
  expect((await ports.readAccountedRecord?.(unauthenticated))?.ok).toBe(false)
  records = []
  expect((await ports.readRecords([ref])).ok).toBe(false)
})

it('production batch fact selection refuses a second action colliding with an authenticated slot', async () => {
  const tools = fileURLToPath(new URL('../../../', import.meta.url))
  const commit = execFileSync('git', ['-C', tools, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const inputs = committedFixtureInputs(tools, standaloneReviewInputs(TEST_SCOPE, TEST_HEAD), commit)
  const initial = historicalReview(inputs, 'batch-collision', negative)
  const expandedInputs = expanded(inputs, initial.entry, 'region.txt')
  const decoded = history([initial.root, initial.entry])
  const slot = initial.root.payload.slots.find((item) => item.action !== undefined)
  if (slot?.action === undefined) throw new Error('expected an authenticated action slot')
  const request = {
    actionId: 'fresh-batch-action',
    purpose: 'review' as const,
    subject: expandedInputs.manifest.subject,
    code: expandedInputs.manifest.code,
    stageSources: expandedInputs.stageSources,
    expandedContext: expandedInputs.manifest.expandedContext,
  }
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: inputs.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [decoded] })
  try {
    const source = {
      cwd: '/fixture',
      readAuthor: NATIVE_AUTHOR,
      gh: async (_cwd: string, args: string[]) => {
        const result = toolingGh(args, tools)
        if (result === undefined) throw new Error(`Unexpected gh call: ${args.join(' ')}`)
        return result
      },
    }
    const valid = await readProductionActionFactsBatch([request], source)
    expect(valid.ok, JSON.stringify(valid)).toBe(true)
    const result = await readProductionActionFactsBatch(
      [request, { ...request, actionId: slot.action.actionId }],
      source,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some((item) => item.code === 'action-input-cycle')).toBe(true)
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
  }
})

it('production preparation materializes an authenticated native negative for review and correction', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-expanded-preparation-'))
  directories.push(directory)
  const pluginBytes = Buffer.from('fixture plugin')
  let installedBytes = pluginBytes
  const pinnedReads = new Map<string, number>()
  const installedReads = new Map<string, number>()
  const contextBytes = Buffer.from('deployment region: eu-west')
  const base = standaloneReviewInputs()
  const request: UwActionRequest = {
    actionId: 'initial-action',
    purpose: 'review',
    subject: { kind: 'standalone-pr', pullRequest: TEST_SCOPE },
    code: { ...base.manifest.code, repository: TEST_SCOPE.repository },
    stageSources: [],
    expandedContext: [],
  }
  let currentHistory = history([])
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: base.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockImplementation(async () => ({
    ok: true,
    value: [currentHistory],
  }))
  try {
    const { readPinnedFiles: _readPinnedFiles, ...production } = createProductionInputPorts({
      cwd: directory,
      gh: async () => '[]',
      readAuthor: NATIVE_AUTHOR,
    })
    let placement = 0
    const ports: UwActionPorts = {
      ...production,
      readPinnedFile: async (ref) => {
        pinnedReads.set(ref.path, (pinnedReads.get(ref.path) ?? 0) + 1)
        return { ok: true, value: ref.path === 'region.txt' ? contextBytes : pluginBytes }
      },
      readCodeDiff: async () => ({ ok: true, value: Buffer.from('diff') }),
      repositoryReferences: async () => ({ ok: true, value: [] }),
      plugin: {
        resolveInstalledPluginPin: async () => ({
          ok: true,
          value: {
            name: 'omp-build',
            version: base.manifest.plugin.version,
            repository: base.manifest.plugin.repository,
            commit: base.manifest.plugin.commit,
            root: base.manifest.plugin.root,
          },
        }),
        readInstalledFile: async (path) => {
          installedReads.set(path, (installedReads.get(path) ?? 0) + 1)
          return { ok: true, value: installedBytes }
        },
      },
      snapshots: {
        create: async ({ files }) => {
          const root = join(directory, `snapshot-${placement++}`)
          for (const file of files) {
            const path = join(root, file.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, file.bytes)
          }
          return { ok: true, value: { indexPath: join(root, 'index.md'), location: 'local' } }
        },
      },
    }
    const operations = actionOperationMethods({ actions: ports })
    const initial = await operations.prepareAction(request)
    expect(initial.ok).toBe(true)
    if (!initial.ok) return
    for (const file of initial.value.inputs.manifest.plugin.files) {
      const path = file.path.slice(`${initial.value.inputs.manifest.plugin.root}/`.length)
      expect(pinnedReads.get(file.path)).toBe(1)
      expect(installedReads.get(path)).toBe(1)
      expect(readFileSync(join(dirname(initial.value.snapshot.indexPath), 'plugin', path))).toEqual(pluginBytes)
    }
    installedBytes = Buffer.from('changed plugin')
    const changed = await operations.prepareAction({ ...request, actionId: 'changed-plugin' })
    expect(changed.ok).toBe(false)
    if (!changed.ok) expect(changed.diagnostics[0]?.code).toBe('plugin-pin-mismatch')
    installedBytes = pluginBytes
    const root = historicalReview(initial.value.inputs, 'materialized-negative', negative)
    currentHistory = history([root.root, root.entry])
    const nativeOperation = currentHistory.operations.find(
      (operation) => operation.record?.recordId === root.entry.recordId,
    )
    expect(nativeOperation?.authority).toBe('authority')
    const recordRef = {
      source: 'record' as const,
      record: { scope: TEST_SCOPE, kind: 'contribution' as const, recordId: root.entry.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(root.entry.payload),
    }
    const fileRef = {
      source: 'git-file' as const,
      repository: TEST_SCOPE.repository,
      commit: 'b'.repeat(40),
      path: 'region.txt',
      digest: sha256Bytes(contextBytes),
    }
    const expandedRequest = { ...request, actionId: 'fresh-review', expandedContext: [recordRef, fileRef] }
    const review = await operations.prepareAction(expandedRequest)
    expect(review.ok).toBe(true)
    if (review.ok) {
      const rootPath = dirname(review.value.snapshot.indexPath)
      expect(JSON.parse(readFileSync(join(rootPath, 'expanded/0.json'), 'utf8'))).toEqual(root.entry.payload)
      expect(readFileSync(join(rootPath, 'expanded/1.bin'), 'utf8')).toBe(contextBytes.toString())
    }
    const correction = { ...expandedRequest, actionId: 'fresh-correction', purpose: 'correction' as const }
    const ordinary = await operations.prepareAction(correction)
    expect(ordinary.ok, ordinary.ok ? undefined : JSON.stringify(ordinary.diagnostics)).toBe(true)
    if (ordinary.ok)
      expect(
        JSON.parse(readFileSync(join(dirname(ordinary.value.snapshot.indexPath), 'expanded/0.json'), 'utf8')),
      ).toEqual(root.entry.payload)

    const tampered = await operations.prepareAction({
      ...correction,
      actionId: 'tampered-correction',
      expandedContext: [{ ...recordRef, digest: '0'.repeat(64) }, fileRef],
    })
    expect(tampered.ok).toBe(false)
    currentHistory = {
      ...currentHistory,
      operations: currentHistory.operations.map((operation) =>
        operation.record?.recordId === root.entry.recordId
          ? { ...operation, authority: 'foreign' as const }
          : operation,
      ),
    }
    const foreign = await operations.prepareAction({ ...correction, actionId: 'foreign-correction' })
    expect(foreign.ok).toBe(false)
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
  }
})
