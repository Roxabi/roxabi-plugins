import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { readGitHubBlob } from '../../roxabi/uw-github-blobs.ts'
import { createInstalledObservedUwReadPort, createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'
import { cleanupFeatureRecoveryRoots, SCOPE, trackFeatureRecoveryRoot } from '../../testing/feature-recovery-fixture.ts'
import { nativeFeatureSpec } from '../../testing/feature-review-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PLUGIN = path.resolve(import.meta.dirname, '../..')
const ROOT = path.resolve(PLUGIN, '../..')
const copies: string[] = []
afterEach(() => {
  cleanupFeatureRecoveryRoots()
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true })
})

it('reconstructs two genuine assessment handoffs across three synthetic bounded versions', async () => {
  const makeCopy = (version: string) => {
    const copy = mkdtempSync(path.join(tmpdir(), 'context-assessment-version-'))
    copies.push(copy)
    const plugin = path.join(copy, 'plugins', 'omp-build')
    mkdirSync(path.dirname(plugin), { recursive: true })
    cpSync(PLUGIN, plugin, { recursive: true })
    symlinkSync(path.join(ROOT, 'node_modules'), path.join(copy, 'node_modules'), 'dir')
    symlinkSync(path.join(ROOT, 'plugins', 'issue-triage'), path.join(copy, 'plugins', 'issue-triage'), 'dir')
    const packagePath = path.join(plugin, 'package.json')
    const metadata = JSON.parse(readFileSync(packagePath, 'utf8')) as { version: string }
    metadata.version = version
    writeFileSync(packagePath, JSON.stringify(metadata))
    return { plugin, packagePath }
  }
  const first = makeCopy('0.20.1')
  const second = makeCopy('0.21.0')
  const currentMetadata = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')) as { version: string }
  const currentVersion = currentMetadata.version
  expect(new Set(['0.20.1', '0.21.0', currentVersion]).size).toBe(3)
  const seed = spawnSync(BUN, [path.join(first.plugin, 'testing/feature-context-version-seed.ts')], {
    encoding: 'utf8',
  })
  if (seed.status !== 0) throw new Error(`Synthetic fixture failed: ${seed.stderr}\n${seed.stdout}`)
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
  const pin = (packagePath: string, label: string) => {
    writeFileSync(pinnedPackage, readFileSync(packagePath))
    git(box, tooling, ['add', 'plugins/omp-build/package.json'])
    git(box, tooling, ['commit', '-qm', label])
    return git(box, tooling, ['rev-parse', 'HEAD']).trim()
  }
  const firstPin = pin(first.packagePath, 'fixture: synthetic first writer')
  const secondPin = pin(second.packagePath, 'fixture: synthetic second writer')
  git(box, tooling, ['repack', '-ad'])
  const envs = [firstPin, secondPin, pins.candidate].map((shared) => ({
    ...pins.env,
    PIN_SHARED: shared,
    OMP_WORKTREE_DIR: worktreeRoot,
  }))
  const gh = async (cwd: string, args: string[]) => execFileSync('gh', args, { cwd, env: envs[2], encoding: 'utf8' })
  for (const [commit, packagePath] of [
    [firstPin, first.packagePath],
    [secondPin, second.packagePath],
    [pins.candidate, path.join(PLUGIN, 'package.json')],
  ] as const) {
    const blob = await readGitHubBlob({
      repository: 'Roxabi/roxabi-plugins',
      commit,
      path: 'plugins/omp-build/package.json',
      cwd: checkout,
      gh,
    })
    if (!blob.ok) throw new Error(`Synthetic pinned package unavailable: ${JSON.stringify(blob)}`)
    expect(Buffer.from(blob.value)).toEqual(readFileSync(packagePath))
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
  const run = (plugin: string, index: number, operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [
        path.join(plugin, 'testing/feature-recovery-runner.ts'),
        operation,
        checkout,
        JSON.stringify({ reference: '#42', control: 'continue', negativeRecordId }),
      ],
      { cwd: checkout, env: envs[index], encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`Feature runner failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as {
      kind?: string
      node?: string
      confirmed?: boolean
      selected?: { kind: string; node: string }
    }
  }
  const assessment = (plugin: string, index: number, handoff = '') => {
    const child = spawnSync(
      BUN,
      [path.join(plugin, 'testing/feature-context-assessment-runner.ts'), checkout, '', '#42', handoff],
      { cwd: checkout, env: envs[index], encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`Native assessment failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as { admitted: boolean; activeAfterSettlement?: boolean; messages: string[] }
  }
  const setSpec = (criterion: string) =>
    writeSim(box, (state) => {
      const issue = state.issues['42']
      if (!issue) throw new Error('Fixture issue unavailable')
      issue.body = nativeFeatureSpec(SCOPE, criterion).body
    })
  setSpec('preserves the region and its timezone')
  expect(assessment(first.plugin, 0)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  const firstNegative = history().operations.find(
    ({ record }) =>
      record?.kind === 'action-receipt' && record.payload.action === 'assess-spec' && record.payload.phase === 'result',
  )?.record
  if (!firstNegative) throw new Error('First native assessment negative unavailable')
  const firstRaw = JSON.stringify(firstNegative)
  const firstAbandonment = run(first.plugin, 0, 'confirmed-abandon')
  expect(firstAbandonment, `First abandonment: ${JSON.stringify(firstAbandonment)}`).toMatchObject({
    kind: 'abandoned',
    confirmed: true,
  })
  const abandonedNative = await createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' }).readUw(SCOPE)
  const abandoned = await createInstalledObservedUwReadPort({ observation: abandonedNative.observation }).readUw(SCOPE)
  expect(abandoned.identity.ok).toBe(true)
  expect(abandoned.accepted.status).not.toBe('accepted')
  const home = abandonedNative.observation.histories.find((entry) => entry.source.scope.target === SCOPE.target)
  const abandon = home?.operations.find(
    ({ record }) => record?.kind === 'operator-control' && record.payload.control === 'abandon',
  )
  if (!home || abandon?.record?.kind !== 'operator-control' || abandon.parts.length === 0)
    throw new Error('Authenticated abandonment unavailable')
  const forged = encodeParts(
    { ...abandon.record, recordId: 'competing-abandon', operationId: 'competing-abandon-op' },
    '# Competing abandonment claim',
    65536,
  )
  if (!forged.ok) throw new Error('Competing abandonment frames unavailable')
  const template = abandon.parts[0]
  if (!template) throw new Error('Abandonment frame template missing')
  const extra = forged.value.map((body, index) => ({
    ...template,
    body,
    nativeId: `competing-abandon-${index}`,
    locator: `${SCOPE.target}:competing-abandon-${index}`,
  }))
  const malformed = home.source.comments.map((comment) =>
    comment.nativeId === template.nativeId
      ? { ...comment, body: comment.body.replace(/part=1\/[0-9]+/, 'part=1/999') }
      : comment,
  )
  for (const [name, comments] of [
    ['malformed abandonment', malformed],
    ['competing abandonment', [...home.source.comments, ...extra]],
  ] as const) {
    const variant = decodeHistory({ ...home.source, comments: [...comments] })
    const observation = {
      ...abandonedNative.observation,
      histories: abandonedNative.observation.histories.map((entry) => (entry === home ? variant : entry)),
    }
    const refused = await createInstalledObservedUwReadPort({ observation }).readUw(SCOPE)
    expect(refused.identity.ok, name).toBe(false)
    expect(refused.accepted.status, name).not.toBe('accepted')
  }
  const secondAssessment = assessment(second.plugin, 1, firstNegative.recordId)
  expect(secondAssessment, `Second authority assessment: ${JSON.stringify(secondAssessment)}`).toMatchObject({
    admitted: true,
    activeAfterSettlement: false,
  })
  const negatives = history().operations.flatMap(({ record }) =>
    record?.kind === 'action-receipt' &&
    record.payload.action === 'assess-spec' &&
    record.payload.phase === 'result' &&
    record.payload.admission === null
      ? [record]
      : [],
  )
  expect(negatives).toHaveLength(2)
  const secondNegative = negatives[1]
  if (!secondNegative) throw new Error('Second assessment negative missing')
  const secondRaw = JSON.stringify(secondNegative)
  expect(run(second.plugin, 1, 'continue')).toMatchObject({ kind: 'blocked' })
  const secondAbandonment = run(second.plugin, 1, 'confirmed-abandon')
  expect(secondAbandonment, `Second abandonment: ${JSON.stringify(secondAbandonment)}`).toMatchObject({
    kind: 'abandoned',
    confirmed: true,
  })
  const successor = run(PLUGIN, 2, 'confirmed-context-successor-material', secondNegative.recordId)
  expect(successor.selected).toMatchObject({ kind: 'action', node: 'assess-spec' })
  expect(run(PLUGIN, 2, 'prepare-context-plan').selected).toMatchObject({ kind: 'action', node: 'plan' })
  setSpec('preserves the region, timezone and locale')
  expect(assessment(PLUGIN, 2)).toMatchObject({ admitted: true, activeAfterSettlement: false })
  const afterIndependent = history()
  expect(
    afterIndependent.operations.filter(
      ({ record }) =>
        record?.kind === 'action-receipt' &&
        record.payload.action === 'assess-spec' &&
        record.payload.phase === 'result' &&
        record.payload.structured !== null &&
        'outcome' in record.payload.structured &&
        record.payload.structured.outcome === 'missing-context',
    ),
  ).toHaveLength(3)
  const count = afterIndependent.operations.length
  expect(run(PLUGIN, 2, 'continue')).toMatchObject({ kind: 'blocked' })
  expect(history().operations).toHaveLength(count)
  const final = history()
  const mandates = final.operations.flatMap(({ record }) => (record?.kind === 'mandate' ? [record] : []))
  expect(mandates.map((record) => record.payload.config.productVersion)).toEqual(['0.20.1', '0.21.0', currentVersion])
  expect(
    final.operations.filter(
      ({ record }) =>
        record?.kind === 'operator-control' &&
        record.payload.control === 'select-successor' &&
        record.payload.contextDisposition,
    ),
  ).toHaveLength(2)
  expect(
    JSON.stringify(final.operations.find(({ record }) => record?.recordId === firstNegative.recordId)?.record),
  ).toBe(firstRaw)
  expect(
    JSON.stringify(final.operations.find(({ record }) => record?.recordId === secondNegative.recordId)?.record),
  ).toBe(secondRaw)
}, 120_000)
