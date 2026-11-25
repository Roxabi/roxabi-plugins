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

it('resumes, pushes, opens and lands the same mandate after an installed package and catalog upgrade', async () => {
  const installedVersion = shippedProductVersion()
  expect(installedVersion).not.toBe(previousVersion)
  expect(marketplace.plugins.find((plugin) => plugin.name === 'omp-build')?.version).toBe(installedVersion)

  const f = world(false, 'main', recordedConfig)
  expect(f.mandate.payload.config).toMatchObject({ productVersion: previousVersion, digest: recordedConfig.digest })
  const pause = fixtures.pauseRequested(f.mandate)
  seedAuthority(f.box, [f.mandate, pause, fixtures.pauseConfirmed(f.mandate, pause)])
  f.bare('update-ref', '-d', ref)

  const openedPr = 100
  const rules = [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'review', integration_id: 17 }, { context: 'ci' }] },
    },
  ]
  const gh: Gh = async (cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    if (args[1] === `repos/${repository}/rules/branches/main`) return JSON.stringify(rules)
    if (args.some((arg) => arg.includes('OMP_BUILD_TOOLING_SHA'))) throw new Error('Host pin is stale')
    if (args[0] === 'pr' && args[1] === 'merge') {
      expect(args).toEqual([
        'pr',
        'merge',
        String(openedPr),
        '--repo',
        repository,
        '--merge',
        '--match-head-commit',
        f.tip,
      ])
      expect(f.bare('rev-parse', ref)).toBe(f.tip)
      git(f.box, f.box.principal, ['merge', '--no-ff', '-qm', 'Merge PR', f.tip])
      const merged = git(f.box, f.box.principal, ['rev-parse', 'HEAD'])
      git(f.box, f.box.principal, ['push', '-q', 'origin', 'main'])
      writeSim(f.box, (state) => {
        const pull = state.prs[String(openedPr)]
        if (!pull) throw new Error('Expected the composed flow to open the PR')
        pull.state = 'MERGED'
        pull.mergeCommit = { oid: merged, parents: [f.base, f.tip] }
      })
      return ''
    }
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
    control: 'resume',
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
