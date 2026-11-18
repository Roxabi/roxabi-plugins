import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { publishFirstParentChild } from '../../testing/feature-context-parent-proposal.ts'
import { cleanupFeatureRecoveryRoots, trackFeatureRecoveryRoot } from '../../testing/feature-recovery-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { recordsOf } from '../workflow-control.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PLUGIN = path.resolve(import.meta.dirname, '../..')
const ROOT = path.resolve(PLUGIN, '../..')
const PARENT = { repository: 'acme/app', target: 'acme/app#200' }
const copies: string[] = []
afterEach(() => {
  cleanupFeatureRecoveryRoots()
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true })
})

it('reads first-child delivery against the recovered parent accepted Spec after a genuine succession', async () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'context-parent-operands-'))
  copies.push(copy)
  const oldPlugin = path.join(copy, 'plugins', 'omp-build')
  mkdirSync(path.dirname(oldPlugin), { recursive: true })
  cpSync(PLUGIN, oldPlugin, { recursive: true })
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir')
  symlinkSync(path.join(ROOT, 'plugins', 'issue-triage'), path.join(copy, 'plugins', 'issue-triage'), 'dir')
  const packagePath = path.join(oldPlugin, 'package.json')
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }
  const currentVersion = metadata.version
  metadata.version = '0.21.0'
  if (metadata.version === currentVersion) throw new Error('Synthetic package versions must differ')
  writeFileSync(packagePath, JSON.stringify(metadata))
  const seed = spawnSync(BUN, [path.join(oldPlugin, 'testing/feature-context-parent-version-seed.ts')], {
    encoding: 'utf8',
  })
  if (seed.status !== 0) throw new Error(`Parent seed failed: ${seed.stderr}\n${seed.stdout}`)
  const fixture = JSON.parse(seed.stdout) as {
    box: Box
    checkout: string
    worktreeRoot: string
    original: string
    proposed: string
    proposedVersion: string
  }
  const { box, checkout, worktreeRoot } = fixture
  trackFeatureRecoveryRoot(box.root)
  const pins = isolatedPinSandbox(box)
  const tooling = path.join(box.root, 'omp-tooling.git')
  writeFileSync(path.join(tooling, 'plugins/omp-build/package.json'), readFileSync(packagePath))
  git(box, tooling, ['add', 'plugins/omp-build/package.json'])
  git(box, tooling, ['commit', '-qm', 'fixture: bounded synthetic predecessor package'])
  const oldPin = git(box, tooling, ['rev-parse', 'HEAD']).trim()
  git(box, tooling, ['repack', '-ad'])
  const oldEnv = { ...pins.env, PIN_SHARED: oldPin, OMP_WORKTREE_DIR: worktreeRoot }
  const currentEnv = { ...pins.env, PIN_SHARED: pins.candidate, OMP_WORKTREE_DIR: worktreeRoot }
  const history = () =>
    decodeHistory({
      scope: PARENT,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues['200']?.comments ?? []).map((comment, index) => ({
        locator: `${PARENT.target}:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  const worker = (runner: string, env: NodeJS.ProcessEnv, args: string[]) => {
    const result = spawnSync(BUN, [runner, ...args], { cwd: checkout, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Parent worker failed: ${result.stderr}\n${result.stdout}`)
    return JSON.parse(result.stdout) as Record<string, unknown>
  }
  const oldAssessment = path.join(oldPlugin, 'testing/feature-context-assessment-runner.ts')
  const assessment = path.join(PLUGIN, 'testing/feature-context-assessment-runner.ts')
  const runner = path.join(PLUGIN, 'testing/feature-recovery-runner.ts')
  writeSim(box, (state) => {
    const issue = state.issues['200']
    if (!issue) throw new Error('Parent issue unavailable')
    issue.body = fixture.proposed
  })
  const first = worker(oldAssessment, oldEnv, [checkout, '', '#200'])
  expect(first, JSON.stringify(first)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  const firstHistory = history()
  const firstNegative = recordsOf(firstHistory).find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result',
  )
  if (
    firstNegative?.kind !== 'action-receipt' ||
    firstNegative.payload.action !== 'assess-spec' ||
    firstNegative.payload.phase !== 'result'
  )
    throw new Error('First parent negative unavailable')
  expect(firstNegative.payload).toMatchObject({ structured: { outcome: 'missing-context' }, admission: null })
  const predecessorNegative = JSON.stringify(firstNegative)
  const abandon = worker(path.join(oldPlugin, 'testing/feature-recovery-runner.ts'), oldEnv, [
    'confirmed-abandon',
    checkout,
    JSON.stringify({ reference: '#200', control: 'continue' }),
  ])
  expect(abandon, `Parent abandonment: ${JSON.stringify(abandon)}`).toMatchObject({
    kind: 'abandoned',
    confirmed: true,
  })
  const second = worker(assessment, currentEnv, [checkout, '', '#200', firstNegative.recordId])
  expect(second, JSON.stringify(second)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  const secondHistory = history()
  const mandates = recordsOf(secondHistory).filter((record) => record.kind === 'mandate')
  expect(mandates).toHaveLength(2)
  const selected = mandates[1]
  if (selected?.kind !== 'mandate') throw new Error('Parent successor unavailable')
  expect(selected.payload.config.productVersion).toBe(currentVersion)
  expect(selected.payload.ownSpec.version).toBe(fixture.original)
  const secondNegative = recordsOf(secondHistory).find(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'assess-spec' &&
      record.payload.phase === 'result' &&
      record.recordId !== firstNegative.recordId,
  )
  if (
    secondNegative?.kind !== 'action-receipt' ||
    secondNegative.payload.action !== 'assess-spec' ||
    secondNegative.payload.phase !== 'result'
  )
    throw new Error('Second parent negative unavailable')
  expect(secondNegative.payload).toMatchObject({ structured: { outcome: 'missing-context' }, admission: null })
  const secondStartRef = secondNegative.payload.start
  const start = recordsOf(secondHistory).find(
    (record) => record.kind === 'action-receipt' && record.recordId === secondStartRef.recordId,
  )
  if (start?.kind !== 'action-receipt' || start.payload.action !== 'assess-spec' || start.payload.phase !== 'start')
    throw new Error('Second parent assessment START unavailable')
  expect(start.payload.mandate.recordId).toBe(selected.recordId)
  const inputs = start.payload.inputs
  const manifest = inputs.manifest
  const actionFile = path.join(box.root, 'expanded-parent-assessment.json')
  writeFileSync(
    actionFile,
    JSON.stringify({
      request: {
        actionId: 'expanded-parent-assessment',
        purpose: manifest.purpose,
        subject: manifest.subject,
        code: manifest.code,
        ...(manifest.operands === undefined ? {} : { operands: manifest.operands }),
        stageSources: inputs.stageSources,
        expandedContext: [
          ...manifest.expandedContext,
          {
            source: 'record',
            record: { scope: PARENT, kind: 'action-receipt', recordId: secondNegative.recordId },
            selector: '/payload',
            digest: canonicalValueDigest(secondNegative.payload),
          },
          {
            source: 'git-file',
            repository: PARENT.repository,
            commit: manifest.code.head,
            path: 'fixture.txt',
            digest: createHash('sha256').update('base\n').digest('hex'),
          },
        ],
      },
    }),
  )
  const recovered = worker(assessment, currentEnv, [checkout, actionFile, '#200'])
  expect(recovered, JSON.stringify(recovered)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  const accepted = worker(runner, currentEnv, [
    'accept-existing-parent-material',
    checkout,
    JSON.stringify({ reference: '#200', control: 'continue' }),
  ])
  const recoveredHistory = history()
  const recoveredStart = recordsOf(recoveredHistory).find(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'assess-spec' &&
      record.payload.phase === 'start' &&
      record.payload.actionId === 'expanded-parent-assessment',
  )
  if (
    recoveredStart?.kind !== 'action-receipt' ||
    recoveredStart.payload.action !== 'assess-spec' ||
    recoveredStart.payload.phase !== 'start'
  )
    throw new Error('Expanded parent assessment START unavailable')
  expect(recoveredStart.payload.mandate.recordId).toBe(selected.recordId)
  const positive = recordsOf(recoveredHistory).find(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.action === 'assess-spec' &&
      record.payload.phase === 'result' &&
      record.payload.start.recordId === recoveredStart.recordId,
  )
  expect(positive).toMatchObject({
    payload: { structured: { classification: 'material' }, native: { completion: 'completed', strict: 'valid' } },
  })
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ status: 'accepted' })
  expect(JSON.stringify(recordsOf(history()).find((record) => record.recordId === firstNegative.recordId))).toBe(
    predecessorNegative,
  )
  const child = await publishFirstParentChild({ box, checkout, env: currentEnv })
  expect(child.parent.recordId).toBe(selected.recordId)
  expect(child.acceptedParent.ref.version).toBe(fixture.proposedVersion)
  expect(child.mandate.payload.inheritedOwnSpecRefs).toContainEqual(child.acceptedParent.ref)
  const delivery = await child.operations.readDelivery(child.scope)
  if (!delivery.ok) throw new Error(`Child delivery observation refused: ${JSON.stringify(delivery)}`)
  expect(delivery.value.effective, JSON.stringify(delivery.value.effective)).toMatchObject({ ok: true })
  if (!delivery.value.effective.ok) throw new Error('Child effective Spec unavailable')
  expect(delivery.value.effective.value.versionVector).toContainEqual(child.acceptedParent.ref)
  const parentDelivery = await child.operations.readDelivery(PARENT)
  if (!parentDelivery.ok) throw new Error(`Parent delivery observation refused: ${JSON.stringify(parentDelivery)}`)
  expect(parentDelivery.value.effective, JSON.stringify(parentDelivery.value.effective)).toMatchObject({ ok: true })
}, 120_000)
