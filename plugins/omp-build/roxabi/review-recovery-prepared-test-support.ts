import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAXONOMY } from '../engine/__tests__/record-test-support.ts'
import { SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { fixtureUwOperations, freshReviewInputs } from '../testing/action-input-fixtures.ts'
import { TEST_HEAD } from '../testing/record-builders.ts'
import type { PreparedReviewInputs } from './review-input-contract.ts'
import { allocateReviewPanel } from './review-panel.ts'
import { sealedIndex } from './uw-action-projection.ts'
import { sealActionSnapshot } from './uw-action-snapshot.ts'

const fresh = freshReviewInputs()
export const recoveryFreshInput = fresh.fingerprint

function freshPreparedAction(taskName: string, prepared: PreparedReviewInputs) {
  const directory = mkdtempSync(join(tmpdir(), 'recovery-grant-'))
  const projection = {
    taskName,
    assignedChunk: taskName === 'spec' ? null : Number(taskName.split('-')[1]),
    contextWindow: prepared.contextWindow,
    chunks: prepared.chunks,
  }
  const files = [
    { path: 'manifest.json', bytes: Buffer.from(JSON.stringify(fresh.manifest)) },
    {
      path: 'review/assignment.json',
      bytes: Buffer.from(
        JSON.stringify({
          taskName,
          assignedChunk: projection.assignedChunk,
          contextWindow: projection.contextWindow,
          chunks: prepared.chunks.map((chunk) => ({ index: chunk.index, paths: [], files: [] })),
        }),
      ),
    },
    ...prepared.chunks.flatMap((chunk) => [
      { path: `review/chunks/${chunk.index}.patch`, bytes: Buffer.from(chunk.diff) },
      { path: `review/digests/${chunk.index}.md`, bytes: Buffer.from(chunk.digest) },
    ]),
  ]
  files.push({ path: 'index.md', bytes: Buffer.from(sealedIndex(fresh.manifest, files, projection)) })
  for (const file of files) {
    mkdirSync(join(directory, file.path, '..'), { recursive: true })
    writeFileSync(join(directory, file.path), file.bytes)
  }
  const sealed = sealActionSnapshot(
    {
      id: `${TEST_HEAD}:${taskName}`,
      actionId: `${TEST_HEAD}:${taskName}`,
      manifestDigest: fresh.fingerprint,
      indexPath: join(directory, 'index.md'),
      location: 'local',
    },
    files,
  )
  if (!sealed.ok) throw new Error(sealed.diagnostics.map((item) => item.message).join('; '))
  return { inputs: fresh, snapshot: sealed.value }
}

export function preparedReview(): { ok: true; value: PreparedReviewInputs } {
  const prepared: PreparedReviewInputs = {
    scope: SCOPE,
    context: {
      ...SCOPE,
      number: 42,
      candidateGitSHA: TEST_HEAD,
      input: fresh.fingerprint,
      subject: { kind: 'pull-request' },
    },
    pr: { number: 42, head: TEST_HEAD, base: 'main', baseGitSHA: 'c'.repeat(40), branch: 'feature/bounded' },
    automationLogin: 'automation',
    capture: {
      ok: true,
      input: recoveryFreshInput,
      body: { body: 'recovery pull request', lastEditedAt: null },
      semantic: null as never,
      semanticCanon: 'recovery-fixture-semantic',
    },
    observedEvidence: {
      reviewInput: recoveryFreshInput,
      candidate: { head: TEST_HEAD, base: 'c'.repeat(40) },
      pullRequest: { body: 'recovery pull request', lastEditedAt: null },
      stack: { candidate: null, base: null },
      resolvedSpec: null,
    },
    inputSnapshot: fresh,
    issueSpec: null,
    semanticContext: null as never,
    tier: 'S',
    warnings: [],
    chunks: [
      {
        index: 0,
        delta: ['src/recovery.ts'],
        diff: 'diff --git a/src/recovery.ts b/src/recovery.ts',
        files: [],
        digest: 'chunk-1',
      },
    ],
    contextWindow: 200_000,
    roster: {
      delta: ['src/recovery.ts'],
      tier: 'S',
      chunks: 1,
      claims: [],
      pricedClaimOk: true,
      specDraft: false,
      axialAdr: false,
      stackPaths: { frontendPath: 'web', sharedUi: 'ui', backendPath: 'src' },
      config: { maxAgents: 1, axialOverride: 'default', overrides: {}, warnings: [] },
    },
    config: { canonicalClasses: TAXONOMY, chunker: 'fixture', digest: 'fixture' },
    policy: { version: 'baseline' },
    semantic: {
      assets: null as never,
      spec: null as never,
      prompts: { spec: 'Assess the specification.', panel: 'Assess the candidate.' } as never,
    },
    rawOperatorRequest: null,
    actions: {},
    operations: fixtureUwOperations(),
  }
  const panel = allocateReviewPanel({
    chunks: prepared.chunks,
    roster: prepared.roster,
    config: prepared.config,
    commonContext: prepared.semantic.prompts.panel,
  })
  prepared.actions = Object.fromEntries(
    ['spec', ...panel.tasks.map((task) => task.name)].map((name) => [name, freshPreparedAction(name, prepared)]),
  )
  return { ok: true, value: prepared }
}
