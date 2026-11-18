import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { observeCurrentContextSuccession } from '../../roxabi/feature-context-handoff-observation.ts'
import { resolveFeatureAuthority } from '../../roxabi/feature-continuation-admission.ts'
import { defaultGh } from '../../roxabi/feature-engine.ts'
import { readGitHubBlob } from '../../roxabi/uw-github-blobs.ts'
import { currentParentIntegration } from '../../roxabi/uw-parent-current-integration.ts'
import { createInstalledObservedUwReadPort, createInstalledUwReadPort } from '../../roxabi/uw-read-port.ts'
import { continueFeature } from '../../roxabi/workflow.ts'
import { defaultGit } from '../../roxabi/workflow-checkout.ts'
import { withEpicEffects } from '../../skills/feature/epic-driver-runtime.ts'
import { deliverParentChildren } from '../../testing/feature-context-parent-delivery.ts'
import { proposeParentChildV2 } from '../../testing/feature-context-parent-proposal.ts'
import { cleanupFeatureRecoveryRoots, trackFeatureRecoveryRoot } from '../../testing/feature-recovery-fixture.ts'
import { isolatedPinSandbox } from '../../testing/isolated-pin-sandbox.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import type { Box } from '../../testing/sandbox/sandbox-types.ts'
import { recordsOf } from '../workflow-control.ts'
import { selectedMandate } from '../workflow-mandate-admission.ts'
import { assertParentNegative, assertSuccessionFrames } from './workflow-context-historical-ownership-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const PLUGIN = path.resolve(import.meta.dirname, '../..')
const ROOT = path.resolve(PLUGIN, '../..')
const RUNNER = path.join(PLUGIN, 'testing/feature-recovery-runner.ts')
const PARENT = { repository: 'acme/app', target: 'acme/app#200' }
const copies: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  cleanupFeatureRecoveryRoots()
  for (const copy of copies.splice(0)) rmSync(copy, { recursive: true, force: true })
})

it('retains a native parent assessment negative across version succession and same-world child delivery', async () => {
  const copy = mkdtempSync(path.join(tmpdir(), 'context-parent-synthetic-'))
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
  if (seed.status !== 0) throw new Error(`Synthetic parent seed failed: ${seed.stderr}\n${seed.stdout}`)
  const fixture = JSON.parse(seed.stdout) as {
    box: Box
    checkout: string
    worktreeRoot: string
    original: string
    proposed: string
    proposedVersion: string
  }
  const { box, checkout, worktreeRoot } = fixture
  vi.stubEnv('OMP_WORKTREE_DIR', worktreeRoot)
  trackFeatureRecoveryRoot(box.root)
  const pins = isolatedPinSandbox(box)
  const tooling = path.join(box.root, 'omp-tooling.git')
  writeFileSync(path.join(tooling, 'plugins/omp-build/package.json'), readFileSync(packagePath))
  git(box, tooling, ['add', 'plugins/omp-build/package.json'])
  git(box, tooling, ['commit', '-qm', 'fixture: synthetic current-algorithm predecessor package'])
  const oldPin = git(box, tooling, ['rev-parse', 'HEAD']).trim()
  const oldEnv = { ...pins.env, PIN_SHARED: oldPin, OMP_WORKTREE_DIR: worktreeRoot }
  const currentEnv = { ...pins.env, PIN_SHARED: pins.candidate, OMP_WORKTREE_DIR: worktreeRoot }
  git(box, tooling, ['repack', '-ad'])
  // Exercise the production GH transport rather than a smaller fixture-only output buffer.
  for (const [key, value] of Object.entries(currentEnv)) {
    if (value !== undefined && process.env[key] !== value) vi.stubEnv(key, value)
  }
  const gh = defaultGh()
  for (const [commit, expected] of [
    [oldPin, readFileSync(packagePath)],
    [pins.candidate, readFileSync(path.join(PLUGIN, 'package.json'))],
  ] as const) {
    const blob = await readGitHubBlob({
      repository: 'Roxabi/roxabi-plugins',
      commit,
      path: 'plugins/omp-build/package.json',
      cwd: checkout,
      gh,
    })
    if (!blob.ok) throw new Error(`Pinned synthetic package unavailable: ${JSON.stringify(blob)}`)
    expect(Buffer.from(blob.value)).toEqual(expected)
  }
  const initialHead = git(box, checkout, ['rev-parse', 'HEAD']).trim()
  const history = (number: number) => {
    const scope = { repository: PARENT.repository, target: `${PARENT.repository}#${number}` }
    return decodeHistory({
      scope,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      diagnostics: [],
      comments: (readSim(box).issues[String(number)]?.comments ?? []).map((comment, index) => ({
        locator: `${scope.target}:${index + 1}`,
        nativeId: String(index + 1),
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt ?? null,
        updatedAt: comment.updatedAt ?? null,
      })),
    })
  }
  const assertUnmanagedChildren = () => {
    for (const number of [201, 202, 203]) {
      const child = history(number)
      expect(child.source.complete).toBe(true)
      expect(
        child.operations.some(
          (operation) => operation.kind === 'mandate' || operation.claimedKinds.includes('mandate'),
        ),
      ).toBe(false)
    }
  }
  const run = (runner: string, env: NodeJS.ProcessEnv, operation: string, negativeRecordId = '') => {
    const child = spawnSync(
      BUN,
      [runner, operation, checkout, JSON.stringify({ reference: '#200', control: 'continue', negativeRecordId })],
      { cwd: checkout, env, encoding: 'utf8' },
    )
    if (child.status !== 0) throw new Error(`Parent worker failed: ${child.stderr}\n${child.stdout}`)
    return JSON.parse(child.stdout) as {
      kind?: string
      confirmed?: boolean
      coverageRequests?: number
      coverageRequestedParentVersion?: string
      changedParentVersion?: string
      startsBeforeCoverage?: number
      startsAfterCoverage?: number
      startsAfterRepeatedCoverage?: number
      startsAfterColdRepeated?: number
      repeatedCoverage?: { kind: string; reason?: string }
      coldRepeated?: { kind: string; reason?: string }
      before?: { starts: number; mandates: string[] }
      after?: { starts: number; mandates: string[] }
      coverageVersion?: string
      oldCurrent?: boolean
      active?: boolean
      messages?: unknown[]
      selected?: { kind: string; node: string; start?: { scope: typeof PARENT } }
      material?: { before: { version: string }; after: { version: string } }
    }
  }
  assertUnmanagedChildren()
  writeSim(box, (state) => {
    const issue = state.issues['200']
    if (!issue) throw new Error('Parent issue unavailable')
    issue.body = fixture.proposed
  })
  const assessment = spawnSync(
    BUN,
    [path.join(oldPlugin, 'testing/feature-context-assessment-runner.ts'), checkout, '', '#200'],
    { cwd: checkout, env: oldEnv, encoding: 'utf8' },
  )
  if (assessment.status !== 0) throw new Error(`Parent assessment failed: ${assessment.stderr}\n${assessment.stdout}`)
  const assessmentResult = JSON.parse(assessment.stdout) as {
    admitted: boolean
    messages: string[]
    activeAfterSettlement?: boolean
    coverageEdits: number
  }
  expect(assessmentResult, `Public parent assessment dispatch: ${JSON.stringify(assessmentResult)}`).toMatchObject({
    admitted: true,
    activeAfterSettlement: false,
    coverageEdits: 1,
  })
  const { predecessor, negative } = assertParentNegative(history, fixture, metadata, PARENT)
  const retained = JSON.stringify(negative)
  assertUnmanagedChildren()
  const abandonment = run(path.join(oldPlugin, 'testing/feature-recovery-runner.ts'), oldEnv, 'confirmed-abandon')
  expect(abandonment, `Public parent abandonment: ${JSON.stringify(abandonment)}`).toMatchObject({
    kind: 'abandoned',
    confirmed: true,
  })
  expect(git(box, checkout, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
  // Fork the disposable remote observation so the stale-basis hold cannot consume the success path.
  const beforeSuccessor = readFileSync(box.stateFile, 'utf8')
  const ownerRace = run(RUNNER, currentEnv, 'confirmed-parent-context-owner-race', negative.recordId)
  expect(ownerRace, JSON.stringify(ownerRace)).toMatchObject({
    coverageVersion: fixture.proposedVersion,
    oldCurrent: false,
    active: false,
  })
  expect(ownerRace.before?.mandates).toHaveLength(2)
  expect(ownerRace.after).toEqual(ownerRace.before)
  expect(JSON.stringify(ownerRace.messages)).not.toContain('OMP_BUILD_NATIVE_BATCH')
  writeFileSync(box.stateFile, beforeSuccessor)
  const staleBasis = run(RUNNER, currentEnv, 'confirmed-parent-context-successor-stale-coverage', negative.recordId)
  expect(staleBasis, JSON.stringify(staleBasis)).toMatchObject({
    coverageRequests: 1,
    coverageRequestedParentVersion: fixture.proposedVersion,
    selected: { kind: 'blocked', reason: 'parent-coverage-intent-changed' },
  })
  expect(staleBasis.changedParentVersion).toBeDefined()
  expect(staleBasis.changedParentVersion).not.toBe(fixture.proposedVersion)
  expect(staleBasis.startsBeforeCoverage).toBeDefined()
  expect(staleBasis.startsAfterCoverage).toBe(staleBasis.startsBeforeCoverage)
  writeFileSync(box.stateFile, beforeSuccessor)
  const successor = run(RUNNER, currentEnv, 'confirmed-parent-context-successor-material', negative.recordId)
  expect(successor, JSON.stringify(successor)).toMatchObject({
    coverageRequests: 1,
    coverageRequestedParentVersion: fixture.proposedVersion,
  })
  expect(successor.repeatedCoverage).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-continuation-consumed' })
  expect(successor.coldRepeated).toMatchObject({ kind: 'blocked' })
  expect(successor.startsAfterCoverage).toBeDefined()
  expect(successor.startsAfterRepeatedCoverage).toBe(successor.startsAfterCoverage)
  expect(successor.startsAfterColdRepeated).toBe(successor.startsAfterCoverage)
  expect(successor.selected).toMatchObject({ kind: 'action', node: 'assess-spec', start: { scope: PARENT } })
  expect(successor.material?.before.version).toBe(fixture.original)
  expect(successor.material?.after.version).toBe(fixture.proposedVersion)
  assertUnmanagedChildren()
  const parentAfter = history(200)
  const mandates = recordsOf(parentAfter).filter((record) => record.kind === 'mandate')
  expect(mandates).toHaveLength(2)
  const selected = mandates[1]
  if (selected?.kind !== 'mandate') throw new Error('Selected parent successor unavailable')
  expect(selected.payload.config.productVersion).toBe(currentVersion)
  expect(selected.payload.ownSpec.version).toBe(fixture.original)
  expect(
    recordsOf(parentAfter).filter(
      (record) => record.kind === 'operator-control' && record.payload.control === 'accept-material',
    ),
  ).toHaveLength(1)
  expect(
    recordsOf(parentAfter).some(
      (record) =>
        record.kind === 'operator-control' &&
        record.payload.control === 'select-successor' &&
        record.payload.contextDisposition?.negative.record.recordId === negative.recordId,
    ),
  ).toBe(true)
  expect(JSON.stringify(recordsOf(parentAfter).find((record) => record.recordId === negative.recordId))).toBe(retained)
  const reader = createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' })
  const authority = await resolveFeatureAuthority({
    cwd: checkout,
    reference: '#200',
    control: 'continue',
    principal: false,
    gh,
    git: defaultGit(),
    read: reader,
  })
  if ('kind' in authority) throw new Error(`Fresh successor authority unavailable: ${JSON.stringify(authority)}`)
  const observedSuccession = await observeCurrentContextSuccession({
    authority,
    mandate: selected,
    causal: authority.causal,
  })
  if (!observedSuccession.ok || observedSuccession.value === null)
    throw new Error(`Fresh succession observation unavailable: ${JSON.stringify(observedSuccession)}`)
  assertSuccessionFrames(authority, selected, predecessor, negative, PARENT)
  async function deliverAcceptedChildren() {
    const childProposal = proposeParentChildV2({ box })
    const proposedOnly = await reader.readUw(PARENT)
    if (proposedOnly.accepted.status !== 'accepted')
      throw new Error('Accepted parent unavailable before child material assessment')
    expect(
      proposedOnly.accepted.value.children.find((child) => child.scope.target === childProposal.scope.target)
        ?.specVersion,
    ).toBe(childProposal.beforeVersion)
    expect(childProposal.afterVersion).not.toBe(childProposal.beforeVersion)
    assertUnmanagedChildren()
    // Continue must assess the proposed child revision, not advance a child on unaccepted material.
    const childMaterial = run(RUNNER, currentEnv, 'accept-parent-child-material')
    expect(childMaterial.coverageRequests).toBe(1)
    expect(childMaterial.selected, `Proposed-only parent continuation: ${JSON.stringify(childMaterial)}`).toMatchObject(
      {
        kind: 'action',
        node: 'assess-spec',
        start: { scope: PARENT },
      },
    )
    const acceptedChild = await reader.readUw(PARENT)
    if (acceptedChild.accepted.status !== 'accepted') throw new Error('Parent child material was not accepted')
    expect(
      acceptedChild.accepted.value.children.find((child) => child.scope.target === childProposal.scope.target)
        ?.specVersion,
    ).toBe(childProposal.afterVersion)
    assertUnmanagedChildren()
    const delivery = await deliverParentChildren({
      box,
      checkout,
      env: currentEnv,
      child201Version: childProposal.afterVersion,
    })
    const childRead = await delivery.operations.readUw(PARENT)
    if (childRead.accepted.status !== 'accepted') throw new Error('Accepted parent material unavailable after delivery')
    expect(childRead.accepted.value.ref.version).toBe(successor.material?.after.version)
    for (const review of delivery.reviews) {
      const childHistory = childRead.histories.find((entry) => entry.source.scope.target === review.uw.target)
      if (!childHistory) throw new Error(`Missing child history ${review.uw.target}`)
      const child = selectedMandate(childHistory)
      if (!('kind' in child) || child.kind !== 'mandate') throw new Error('Child mandate not selected')
      expect(child.payload.parent?.recordId).toBe(selected.recordId)
      expect(child.payload.inheritedOwnSpecRefs).toContainEqual(childRead.accepted.value.ref)
      expect(childRead.completion.completions.get(`${review.uw.repository}\0${review.uw.target}`)?.state).toBe(
        'complete',
      )
    }
    return delivery
  }
  const delivery = await deliverAcceptedChildren()
  const planned = run(RUNNER, currentEnv, 'prepare-parent-context-plan')
  expect(planned.selected).toMatchObject({ kind: 'action', node: 'plan', start: { scope: PARENT } })
  const gitPort = defaultGit()
  const observed = delivery.parentCheckout.observe()
  expect(observed).toMatchObject({
    branch: null,
    head: delivery.thirdMerge,
    base: 'main',
    baseTip: delivery.thirdMerge,
    remoteTip: delivery.thirdMerge,
  })
  const integrated = await withEpicEffects(
    {
      git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: currentEnv }),
      uw: delivery.operations,
      uwReadAuthor: 'operator',
    },
    () =>
      produceParentIntegration(
        {
          parentScope: PARENT,
          parent: selected,
          reviews: delivery.reviews,
          operations: delivery.operations,
          gh,
          git: gitPort,
          checkout: (expected) => {
            const actual = delivery.parentCheckout.observe()
            if (JSON.stringify(actual) !== JSON.stringify(expected))
              throw new Error(`Parent checkout changed: ${JSON.stringify({ expected, actual })}`)
          },
        },
        delivery.parentCheckout,
        {
          initial: observed,
          candidate: observed,
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
          open: () =>
            continueFeature({
              cwd: checkout,
              reference: '#200',
              control: 'continue',
              principal: false,
              gh,
              git: gitPort,
              uw: delivery.operations,
            }),
        },
      ),
  )
  async function assertColdDelivery() {
    if (integrated.receipt.payload.action !== 'integrate' || integrated.receipt.payload.phase !== 'result')
      throw new Error('Parent integration receipt unavailable')
    expect(integrated.receipt.payload.admission).toMatchObject({ admitted: true, remoteTip: delivery.thirdMerge })
    const coldReader = createInstalledUwReadPort({ cwd: checkout, gh, readAuthor: 'operator' })
    const cold = await coldReader.readUw(PARENT)
    const current = currentParentIntegration(
      cold,
      integrated.receipt.payload.inputs.manifest.code.base,
      delivery.thirdMerge,
    )
    expect(current.ok && current.value?.source.record.recordId).toBe(integrated.receipt.recordId)
    const observedReader = createInstalledObservedUwReadPort({ observation: cold.observation })
    const observedParent = await observedReader.readUw(PARENT)
    expect(observedParent.accepted).toEqual(cold.accepted)
    expect(observedParent.identity).toEqual(cold.identity)
    expect(observedParent.admission).toEqual(cold.admission)
    if (observedParent.accepted.status !== 'accepted') throw new Error('Cold observed parent material unavailable')
    expect(observedParent.identity.ok).toBe(true)
    expect(observedParent.admission.deliverable.ok).toBe(true)
    for (const review of delivery.reviews) {
      const observedChild = await observedReader.readUw(review.uw)
      if (observedChild.accepted.status !== 'accepted')
        throw new Error(`Cold observed child material unavailable: ${review.uw.target}`)
      expect(observedChild.accepted.value.inheritedOwnSpecRefs).toContainEqual(observedParent.accepted.value.ref)
      expect(observedChild.completion.completions.get(`${review.uw.repository}\0${review.uw.target}`)?.state).toBe(
        'complete',
      )
    }
    for (const review of delivery.reviews)
      expect(cold.completion.completions.get(`${review.uw.repository}\0${review.uw.target}`)?.state).toBe('complete')
  }
  await assertColdDelivery()
  expect(JSON.stringify(recordsOf(history(200)).find((record) => record.recordId === negative.recordId))).toBe(retained)
}, 180_000)
