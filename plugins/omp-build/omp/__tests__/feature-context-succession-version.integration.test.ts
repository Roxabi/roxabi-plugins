import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubBlob } from '../../roxabi/uw-github-blobs.ts'
import { cleanupFeatureRecoveryRoots, SCOPE, trackFeatureRecoveryRoot } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PLUGIN = path.resolve(import.meta.dirname, '../..')
const ROOT = path.resolve(PLUGIN, '../..')
const RUNNER = path.join(PLUGIN, 'testing/feature-recovery-runner.ts')
const copies: string[] = []
afterEach(() => {
  cleanupFeatureRecoveryRoots()
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true })
})

it('requires a confirmed version-only successor instead of silently migrating the negative mandate', async () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'context-old-product-'))
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
  writeFileSync(packagePath, JSON.stringify(metadata))
  const seed = spawnSync(BUN, [path.join(oldPlugin, 'testing/feature-context-version-seed.ts')], { encoding: 'utf8' })
  if (seed.status !== 0) throw new Error(`Old product fixture failed: ${seed.stderr}\n${seed.stdout}`)
  const fixture = JSON.parse(seed.stdout) as { box: Box; checkout: string }
  const { box } = fixture
  trackFeatureRecoveryRoot(box.root)
  const worktreeRoot = path.join(box.root, 'context-worktrees')
  const checkout = path.join(worktreeRoot, 'app', 'feat-42-save')
  mkdirSync(path.dirname(checkout), { recursive: true })
  git(box, box.principal, ['worktree', 'move', fixture.checkout, checkout])
  const pins = isolatedPinSandbox(box)
  const tooling = path.join(box.root, 'omp-tooling.git')
  const pinnedPackage = path.join(tooling, 'plugins/omp-build/package.json')
  writeFileSync(pinnedPackage, readFileSync(packagePath))
  git(box, tooling, ['add', 'plugins/omp-build/package.json'])
  git(box, tooling, ['commit', '-qm', 'fixture: copied-code historical writer pin'])
  const historicalPin = git(box, tooling, ['rev-parse', 'HEAD']).trim()
  const oldEnv = { ...pins.env, PIN_SHARED: historicalPin, OMP_WORKTREE_DIR: worktreeRoot }
  const currentEnv = { ...pins.env, PIN_SHARED: pins.candidate, OMP_WORKTREE_DIR: worktreeRoot }
  // Pack only this disposable tooling fixture; both immutable commits must remain readable.
  git(box, tooling, ['repack', '-ad'])
  const gh = async (cwd: string, args: string[]) => execFileSync('gh', args, { cwd, env: currentEnv, encoding: 'utf8' })
  for (const [commit, expected] of [
    [historicalPin, readFileSync(packagePath)],
    [pins.candidate, readFileSync(path.join(PLUGIN, 'package.json'))],
  ] as const) {
    const blob = await readGitHubBlob({
      repository: 'Roxabi/roxabi-plugins',
      commit,
      path: 'plugins/omp-build/package.json',
      cwd: checkout,
      gh,
    })
    expect(blob.ok, JSON.stringify(blob)).toBe(true)
    if (!blob.ok) throw new Error('Pinned tooling blob unavailable')
    expect(Buffer.from(blob.value)).toEqual(expected)
  }
  const run = (runner: string, operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [
        runner,
        operation,
        checkout,
        JSON.stringify({
          reference: '#42',
          control: 'continue',
          negativeRecordId,
        }),
      ],
      { cwd: checkout, env: runner === RUNNER ? currentEnv : oldEnv, encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as {
      kind?: string
      node?: string
      admitted?: boolean
      selected?: { kind: string; node: string }
      material?: { before: { version: string }; after: { version: string } }
    }
  }
  const history = () =>
    decodeHistory({
      scope: SCOPE,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues['42']?.comments ?? []).map((comment, index) => ({
        locator: `${SCOPE.target}:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  const oldRunner = path.join(oldPlugin, 'testing/feature-recovery-runner.ts')
  const planner = spawnSync(
    BUN,
    [path.join(oldPlugin, 'testing/feature-planner-context-runner.ts'), checkout, 'positive-both'],
    {
      cwd: checkout,
      env: oldEnv,
      encoding: 'utf8',
    },
  )
  if (planner.status !== 0) throw new Error(`Copied-code native planning failed: ${planner.stderr}\n${planner.stdout}`)
  expect(JSON.parse(planner.stdout).selected).toMatchObject({ kind: 'action', node: 'plan' })
  const dispatched = run(oldRunner, 'omp-context-initial-negative')
  expect(dispatched.admitted, JSON.stringify(dispatched)).toBe(true)
  const initial = history()
  const predecessor = initial.operations.find(({ record }) => record?.kind === 'mandate')?.record
  const negative = initial.operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )?.record
  if (predecessor?.kind !== 'mandate' || negative?.kind !== 'action-receipt')
    throw new Error('Old authority or negative unavailable')
  expect(predecessor.payload.config.productVersion).toBe('0.21.0')
  expect(currentVersion).not.toBe(predecessor.payload.config.productVersion)
  const retained = JSON.stringify(negative)
  expect(run(RUNNER, 'continue')).toMatchObject({ kind: 'blocked' })
  const changed = nativeFeatureSpec(SCOPE, 'preserves the region and its timezone')
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('Fixture issue unavailable')
    issue.body = changed.body
  })
  expect(run(oldRunner, 'confirmed-abandon')).toMatchObject({ kind: 'abandoned', confirmed: true })
  const successor = run(RUNNER, 'confirmed-context-successor-material', negative.recordId)
  expect(successor.selected).toMatchObject({ kind: 'action', node: 'assess-spec' })
  expect(successor.material?.before.version).toBe(predecessor.payload.ownSpec.version)
  expect(successor.material?.after.version).toBe(changed.ownSpec.version)
  // This new process reconstructs the successor and publishes the plan it starts.
  expect(run(RUNNER, 'prepare-context-plan').selected).toMatchObject({ kind: 'action', node: 'plan' })
  const final = history()
  expect(
    final.operations.some(
      ({ record }) =>
        record?.kind === 'operator-control' &&
        record.payload.control === 'select-successor' &&
        record.payload.contextDisposition?.negative.record.recordId === negative.recordId,
    ),
  ).toBe(true)
  const mandates = final.operations.flatMap(({ record }) => (record?.kind === 'mandate' ? [record] : []))
  expect(mandates).toHaveLength(2)
  expect(mandates[1]?.payload.config.productVersion).toBe(currentVersion)
  expect(mandates[1]?.payload.ownSpec.version).toBe(predecessor.payload.ownSpec.version)
  expect(mandates[1]?.payload.ownSpec.version).not.toBe(changed.ownSpec.version)
  expect(JSON.stringify(final.operations.find(({ record }) => record?.recordId === negative.recordId)?.record)).toBe(
    retained,
  )
  expect(
    final.operations.filter(
      ({ record }) => record?.kind === 'operator-control' && record.payload.control === 'accept-material',
    ),
  ).toHaveLength(1)
})
