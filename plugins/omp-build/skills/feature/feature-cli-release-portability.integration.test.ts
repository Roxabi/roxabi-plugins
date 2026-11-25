import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import marketplace from '../../../../.omp-plugin/marketplace.json'
import type { Gh } from '../../adapters/github/types.ts'
import { shippedProductVersion } from '../../dist/contracts.js'
import { admitFeature } from '../../omp/omp-feature-admission.ts'
import { createInstalledUwOperations } from '../../roxabi/uw-installed-operations.ts'
import { canonicalJson, configPinDigest, effectiveWorkflowConfig } from '../../roxabi/workflow-config-digest.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { git, readSim, writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import {
  acceptedDigest,
  branch,
  fixtures,
  invoke,
  pr,
  ref,
  repository,
  revoke,
  seedAuthority,
  seedLandingChecks,
  world,
} from './feature-cli.fixture.ts'

const previousVersion = '0.21.17'
const previousConfig = effectiveWorkflowConfig(previousVersion, [])
const recordedConfig = {
  productVersion: previousVersion,
  version: previousConfig.compatibility,
  // Before the upgrade the writer included producer metadata in this digest.
  digest: createHash('sha256').update(canonicalJson(previousConfig)).digest('hex'),
  effective: previousConfig,
}

it('selects, pushes, opens and lands the same mandate after an installed package and catalog upgrade', async () => {
  const installedVersion = shippedProductVersion()
  expect(installedVersion).not.toBe(previousVersion)
  expect(marketplace.plugins.find((plugin) => plugin.name === 'omp-build')?.version).toBe(installedVersion)

  const f = world(false, 'main', recordedConfig)
  expect(f.mandate.payload.config).toMatchObject({ productVersion: previousVersion, digest: recordedConfig.digest })
  // Already-recorded pause markers must not require a resume or a replacement mandate after upgrade.
  const pause = fixtures.pauseRequested(f.mandate)
  seedAuthority(f.box, [f.mandate, pause, fixtures.pauseConfirmed(f.mandate, pause)])
  f.bare('update-ref', '-d', ref)

  const openedPr = 100
  seedLandingChecks(f.box, 'main', f.tip, 17)
  const gh: Gh = async (cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    if (args.some((arg) => arg.includes('OMP_BUILD_TOOLING_SHA'))) throw new Error('Host pin is stale')
    return f.gh(cwd, args)
  }
  const uw = await createInstalledUwOperations({
    cwd: f.cwd,
    gh,
    operator: {
      async executeConfirmed() {
        throw new Error('An installed upgrade must not request another approval')
      },
    },
  })
  const admission = await admitFeature({
    cwd: f.cwd,
    reference: `${repository}#42`,
    control: 'select',
    principal: false,
    gh,
    git: f.gitRunner,
    uw,
  })
  expect(admission, JSON.stringify(admission)).toMatchObject({
    kind: 'ready',
    mandate: f.mandate.recordId,
    branch,
    base: 'main',
  })
  expect(await invoke(f, 'push', ['--tip', f.tip], { gh })).toMatchObject({ code: 0, status: 'pushed', head: f.tip })
  expect(await invoke(f, 'open-pr', ['--tip', f.tip], { gh })).toMatchObject({
    code: 0,
    status: 'created',
    pr: openedPr,
  })
  expect(
    await invoke(f, 'land', ['--pr', String(openedPr), '--head', f.tip, '--spec', acceptedDigest(f)], { gh }),
  ).toMatchObject({
    code: 0,
    status: 'merged',
    head: f.tip,
  })
  expect(readSim(f.box).prs[String(openedPr)]?.state).toBe('MERGED')
  expect(f.bare('rev-parse', 'main^2')).toBe(f.tip)
  expect(readSim(f.box).calls).toContainEqual([
    'pr',
    'merge',
    String(openedPr),
    '--repo',
    repository,
    '--merge',
    '--match-head-commit',
    f.tip,
  ])
})

it('keeps the PR open when only the previous head passed the repository merge lock', async () => {
  const f = world(true, 'main', recordedConfig)
  seedLandingChecks(f.box, 'main', f.tip, 17)
  git(f.box, f.cwd, ['commit', '--allow-empty', '-qm', 'Advance PR after review'])
  const head = git(f.box, f.cwd, ['rev-parse', 'HEAD'])
  git(f.box, f.cwd, ['push', '-q', 'origin', branch])
  expect(head).not.toBe(f.tip)
  expect(f.bare('rev-parse', ref)).toBe(head)

  const merges: string[][] = []
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'pr' && args[1] === 'merge') merges.push(args)
    return f.gh(cwd, args)
  }
  const spec = acceptedDigest(f)
  const land = (candidate: string) =>
    invoke(f, 'land', ['--pr', String(pr), '--head', candidate, '--spec', spec], { gh })
  const expectMergeLock = async () => {
    expect(await land(head)).toMatchObject({ code: 1, status: 'waiting', reason: 'merge-refused' })
    expect(readSim(f.box).prs[String(pr)]).toMatchObject({ state: 'OPEN', mergeCommit: null })
    expect(f.bare('rev-parse', 'main')).toBe(f.base)
  }
  await expectMergeLock()
  writeSim(f.box, (state) => {
    state.checks[head] = (state.checks[f.tip] ?? []).map((check) =>
      check.name === 'review' ? { ...check, appId: 42 } : check,
    )
  })
  await expectMergeLock()
  writeSim(f.box, (state) => {
    state.checks[head] = (state.checks[f.tip] ?? []).filter((check) => check.name === 'review')
  })
  await expectMergeLock()
  const expectedMerge = ['pr', 'merge', String(pr), '--repo', repository, '--merge', '--match-head-commit', head]
  expect(merges).toEqual([expectedMerge, expectedMerge, expectedMerge])
  expect(await land(f.tip)).toMatchObject({ code: 1, status: 'refused', reason: 'pr-head-mismatch' })
  expect(merges).toHaveLength(3)
  expect(readSim(f.box).prs[String(pr)]).toMatchObject({ state: 'OPEN', mergeCommit: null })
})

it('keeps the branch, base, correction-only and revocation locks on pre-upgrade authority', async () => {
  const f = world(true, 'main', recordedConfig)
  const land = ['--pr', String(pr), '--head', f.tip, '--spec', acceptedDigest(f)]
  git(f.box, f.cwd, ['checkout', '-qb', 'unrelated-branch'])
  expect(await invoke(f, 'push', ['--tip', f.tip])).toMatchObject({ code: 1, reason: 'feature-branch-mismatch' })
  git(f.box, f.cwd, ['checkout', '-q', branch])
  f.bare('update-ref', 'refs/heads/unrelated-base', f.base)
  writeSim(f.box, (state) => {
    const pull = state.prs[String(pr)]
    if (!pull) throw new Error('Expected PR to retarget')
    pull.baseRefName = 'unrelated-base'
  })
  expect(await invoke(f, 'land', land)).toMatchObject({ code: 1, reason: 'fix-own-uw-unsettled' })
  const restricted = world(false, 'main', recordedConfig)
  const correction = fixtures.fixOnlyMandate(
    { repository, target: `${repository}#42` },
    { ownSpec: restricted.spec.ownSpec, branch, lineageHead: restricted.base, config: recordedConfig },
  )
  seedAuthority(restricted.box, [correction])
  const correctionLand = ['--pr', String(pr), '--head', restricted.tip, '--spec', acceptedDigest(restricted)]
  expect(await invoke(restricted, 'land', correctionLand, { mandate: correction.recordId })).toMatchObject({
    code: 1,
    reason: 'feature-leaf-mandate-required',
  })
  const revoked = world(false, 'main', recordedConfig)
  revoke(revoked)
  expect(await invoke(revoked, 'push', ['--tip', revoked.tip])).toMatchObject({
    code: 1,
    reason: 'exact-mandate-not-applicable',
  })
  const restrictedState = readSim(restricted.box)
  expect(restrictedState.calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
  const state = readSim(f.box)
  expect(state.calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false)
  expect(state.prs[String(pr)]?.state).toBe('OPEN')
})

it('fingerprints configuration changes, not producer release changes', () => {
  const installedVersion = shippedProductVersion()
  const digest = configPinDigest(effectiveWorkflowConfig(installedVersion, []))
  expect(digest).toBe(configPinDigest(previousConfig))
  expect(digest).not.toBe(configPinDigest(effectiveWorkflowConfig(installedVersion, ['Require a migration note'])))
})
