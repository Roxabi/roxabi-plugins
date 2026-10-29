import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { NATIVE_AUTHOR, TEST_SCOPE } from '../testing/record-builders.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { prepareUwAction } from './uw-action-inputs.ts'
import { observeCode } from './uw-action-observe.ts'
import { type CorrectionActionCode, withCorrectionObservation } from './uw-correction-observation.ts'
import { createProductionActionPorts } from './uw-input-readers.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function reference(record: CanonicalRecord): RecordInputRef {
  return {
    source: 'record',
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: record.kind,
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
}

function fixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'omp-correction-observe-'))
  roots.push(cwd)
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    }).trim()
  git('init', '-q')
  git('remote', 'add', 'origin', `https://github.com/${TEST_SCOPE.repository}.git`)
  const tree = git('mktree')
  const base = git('commit-tree', tree, '-m', 'base')
  const h1 = git('commit-tree', tree, '-p', base, '-m', 'reviewed candidate')
  git('checkout', '-q', '-b', 'feature', h1)
  writeFileSync(path.join(cwd, 'AGENTS.md'), 'corrected content\n')
  git('add', 'AGENTS.md')
  git('commit', '-q', '-m', 'correction')
  const h2 = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', base)

  const raw: unknown = JSON.parse(
    readFileSync(new URL('../engine/__tests__/fixtures/native-correction-records.json', import.meta.url), 'utf8'),
  )
  if (!Array.isArray(raw)) throw new Error('Expected native correction records')
  const records = raw.map((value: unknown) => {
    const parsed = parseRecord(value)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics))
    const record = parsed.value
    if (record.kind === 'review-attempt') return { ...record, payload: { ...record.payload, candidateGitSHA: h1 } }
    if (record.kind === 'contribution' && record.payload.content === 'operator-request') {
      const attempt = record.payload.rawAttempts[0]
      if (attempt === undefined) throw new Error('Expected operator request')
      const pushUrl = `https://github.com/${TEST_SCOPE.repository}.git`
      return {
        ...record,
        payload: {
          ...record.payload,
          rawAttempts: [
            {
              ...attempt,
              raw: {
                operatorRequest: { request: 'repair persistence and authorization then prove each cause' },
                candidateGitSHA: h1,
                publishBinding: {
                  pushUrl,
                  publicationRepository: TEST_SCOPE.repository,
                  localBranch: 'feature',
                  destinationRef: 'refs/heads/feature',
                  localHead: h1,
                  expectedRemoteSHA: h1,
                  defaultBranch: 'main',
                  observed: {
                    target: TEST_SCOPE.target,
                    baseRepository: TEST_SCOPE.repository,
                    baseDefaultBranch: 'main',
                    localRef: 'refs/heads/feature',
                    localHead: h1,
                    pushUrl,
                    remoteRepository: TEST_SCOPE.repository,
                    remoteDefaultBranch: 'main',
                    remoteLine: `${h1}\trefs/heads/feature`,
                    pr: {
                      headRefOid: h1,
                      headRefName: 'feature',
                      baseRefName: 'main',
                      headRepository: TEST_SCOPE.repository,
                    },
                  },
                },
              },
            },
          ],
        },
      }
    }
    return record
  })
  const fix = records.find((record) => record.kind === 'fix-request')
  const decision = records.find((record) => record.kind === 'decision')
  if (!fix || !decision) throw new Error('Expected fix request and decision')
  const comments = records
    .flatMap((record) => {
      const encoded = encodeParts(record, '', 65536)
      if (!encoded.ok) throw new Error(JSON.stringify(encoded.diagnostics))
      return encoded.value
    })
    .map((body, index) => ({
      id: index + 1,
      body,
      user: { login: NATIVE_AUTHOR },
      created_at: '2026-10-21T10:00:00Z',
      updated_at: '2026-10-21T10:00:00Z',
    }))
  const pull = { headRefOid: h1, baseRefOid: base, headRefName: 'feature', baseRefName: 'main', state: 'OPEN' }
  const source = {
    cwd,
    readAuthor: NATIVE_AUTHOR,
    gh: async (_cwd: string, args: string[]) => {
      if (args[0] === 'pr') return JSON.stringify(pull)
      if (args[0] === 'api' && args[1]?.includes('/issues/42/comments?')) return JSON.stringify(comments)
      throw new Error(`Unexpected gh call: ${args.join(' ')}`)
    },
  }
  const request: UwActionRequest = {
    actionId: 'correction-action',
    purpose: 'correction',
    subject: { kind: 'standalone-pr', pullRequest: TEST_SCOPE },
    code: { repository: TEST_SCOPE.repository, base, head: h2, referenceCommit: h2 },
    stageSources: [reference(decision)],
    expandedContext: [],
  }
  const basis: CorrectionActionCode = {
    actionHead: h2,
    originalCandidate: h1,
    expectedRemoteHead: h1,
    request: reference(fix),
    decision: reference(decision),
    cwd,
    branch: 'feature',
    remoteBranch: 'feature',
    base: 'main',
  }
  const observe = (selected = request, selectedBasis = basis) =>
    withCorrectionObservation(selected, selectedBasis, () => observeCode(selected, source))
  return { git, base, h1, h2, pull, request, basis, source, observe }
}

describe('private correction code observation', () => {
  it('observes the clean local H2 while the remote remains at authenticated H1, only inside the capability', async () => {
    const { request, source, observe } = fixture()
    expect(await observe()).toEqual({ ok: true, value: { branch: 'feature', baseName: 'main' } })
    expect(await observeCode(request, source)).toMatchObject({ ok: false })
  })

  it('prepares a sealed H2 snapshot from the authenticated local correction', async () => {
    const { request, basis, source, h2 } = fixture()
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'omp-correction-snapshot-'))
    roots.push(artifactsDir)
    const baseline = standaloneReviewInputs()
    const pluginBytes = Buffer.from('installed plugin fixture')
    const production = createProductionActionPorts({ ...source, artifactsDir })
    const ports = {
      ...production,
      plugin: {
        resolveInstalledPluginPin: async () => ({
          ok: true as const,
          value: {
            name: 'omp-build' as const,
            version: baseline.manifest.plugin.version,
            repository: baseline.manifest.plugin.repository,
            commit: baseline.manifest.plugin.commit,
            root: baseline.manifest.plugin.root,
          },
        }),
        readInstalledFile: async () => ({ ok: true as const, value: pluginBytes }),
      },
      readPinnedFiles: async (refs: readonly unknown[]) => ({
        ok: true as const,
        value: refs.map(() => pluginBytes),
      }),
    }
    const prepared = await withCorrectionObservation(request, basis, () => prepareUwAction(request, ports))
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.diagnostics))
    expect(prepared.value.inputs.manifest.code.head).toBe(h2)
    expect(prepared.value.inputs.manifest.code.referenceCommit).toBe(h2)
    expect(prepared.value.inputs.manifest.repositoryReferences).toEqual(
      expect.arrayContaining([expect.objectContaining({ commit: h2, path: 'AGENTS.md' })]),
    )
    const snapshot = path.dirname(prepared.value.snapshot.indexPath)
    expect(readFileSync(path.join(snapshot, 'diff.patch'), 'utf8')).toContain('+corrected content')
    expect(readFileSync(path.join(snapshot, 'repo', 'AGENTS.md'), 'utf8')).toBe('corrected content\n')
  })

  it('refuses a moved remote head, branch, or base', async () => {
    const { pull, h1, h2, observe } = fixture()
    pull.headRefOid = h2
    expect(await observe()).toMatchObject({ ok: false })
    pull.headRefOid = h1
    pull.headRefName = 'other'
    expect(await observe()).toMatchObject({ ok: false })
    pull.headRefName = 'feature'
    pull.baseRefName = 'other'
    expect(await observe()).toMatchObject({ ok: false })
  })

  it('refuses a checkout belonging to another repository', async () => {
    const { git, observe } = fixture()
    git('remote', 'set-url', 'origin', 'https://github.com/foreign/repository.git')
    expect(await observe()).toMatchObject({ ok: false })
  })

  it('refuses changed request and decision references and scope', async () => {
    const { request, basis, observe } = fixture()
    expect(await observe(request, { ...basis, request: { ...basis.request, digest: '0'.repeat(64) } })).toMatchObject({
      ok: false,
    })
    expect(await observe(request, { ...basis, decision: { ...basis.decision, digest: '0'.repeat(64) } })).toMatchObject(
      { ok: false },
    )
    expect(
      await observe(request, {
        ...basis,
        request: { ...basis.request, record: { ...basis.request.record, recordId: 'foreign-request' } },
      }),
    ).toMatchObject({ ok: false })
    const wrongDecision = { ...basis.decision, record: { ...basis.decision.record, recordId: 'foreign-decision' } }
    expect(
      await observe({ ...request, stageSources: [wrongDecision] }, { ...basis, decision: wrongDecision }),
    ).toMatchObject({ ok: false })
    expect(await observe({ ...request, stageSources: [] })).toMatchObject({ ok: false })
    expect(
      await observe(request, {
        ...basis,
        request: {
          ...basis.request,
          record: { ...basis.request.record, scope: { ...TEST_SCOPE, target: 'acme/widgets#99' } },
        },
      }),
    ).toMatchObject({ ok: false })
  })

  it('does not transfer the capability to a copied request', async () => {
    const { request, basis, source } = fixture()
    const copy = { ...request }
    expect(await withCorrectionObservation(request, basis, () => observeCode(copy, source))).toMatchObject({
      ok: false,
    })
  })

  it('refuses an unrelated local H2 and a checkout not at the authorized head', async () => {
    const { git, request, basis, observe } = fixture()
    const tree = git('mktree')
    const foreign = git('commit-tree', tree, '-m', 'unrelated')
    git('checkout', '-q', '--detach', foreign)
    expect(await observe()).toMatchObject({ ok: false })
    git('checkout', '-q', '-B', 'feature', foreign)
    const other = { ...request, code: { ...request.code, head: foreign, referenceCommit: foreign } }
    expect(await observe(other, { ...basis, actionHead: foreign })).toMatchObject({ ok: false })
  })

  it('continues to observe an ordinary remote review without correction capability', async () => {
    const { request, h1, source } = fixture()
    const review: UwActionRequest = {
      ...request,
      purpose: 'review',
      code: { ...request.code, head: h1, referenceCommit: h1 },
      stageSources: [],
    }
    expect(await observeCode(review, source)).toEqual({ ok: true, value: { branch: 'feature', baseName: 'main' } })
  })
})
