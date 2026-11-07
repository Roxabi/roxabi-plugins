import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { nativeComment, wire } from '../adapters/__tests__/github-workflow-support.ts'
import * as contracts from '../dist/contracts.js'
import { actionInputDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { linkedIssueBinding } from '../roxabi/fix-checkpoint-binding.ts'
import { admitAttributedCiCorrection } from '../roxabi/fix-ci-admission.ts'
import { authorizeFixAction, readLiveCiEvidence } from '../roxabi/fix-ci-evidence.ts'
import type { FixTarget } from '../roxabi/fix-contract.ts'
import { decideFixAuthority } from '../roxabi/fix-mandate-authority.ts'
import { readFreshUwCausalContext } from '../roxabi/fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledObservedUwReadPort, createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { readEffectiveFixConfig } from '../roxabi/workflow-config.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { installedMultiSisterFixture } from './multi-sister-installed-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { git, sandbox } from './sandbox/sandbox-repository.ts'
import { deliverCreatedSister } from './sister-delivery-fixture.ts'

async function checkAuthorityIsolation(
  input: Parameters<typeof decideFixAuthority>[0],
  mandateId: string,
  unrelatedHistory: DecodedHistory,
): Promise<void> {
  const joint = await readFreshUwCausalContext(
    { repository: 'acme/app', target: 'acme/app#42' },
    [unrelatedHistory],
    input.options,
  )
  assert.ok(joint.ok, JSON.stringify(joint))
  if (!joint.ok) throw new Error('Joint native observation is unavailable')
  assert.ok(joint.value.histories.some((entry) => entry.source.scope.target === 'acme/app#77'))
  assert.ok(joint.value.histories.some((entry) => entry.source.scope.target === 'acme/app#42'))
  const reader = input.uw
  const causalOnlyReader = createInstalledObservedUwReadPort({ observation: joint.value.observation })
  for (const uw of [reader, causalOnlyReader]) {
    const authority = await decideFixAuthority({ ...input, uw })
    assert.ok(
      authority.ok && authority.value.status === 'reuse' && authority.value.mandate.recordId === mandateId,
      JSON.stringify(authority),
    )
  }
}

async function main(): Promise<void> {
  // GitHub and action receipts are simulated; configuration is read from a real commit by the real Bun parser.
  const box = sandbox({
    base: { '.dev/stack.yml': 'package_manager: bun\n', 'README.md': 'base\n' },
    branches: [
      {
        name: 'feat/42-save',
        from: 'main',
        commits: [{ message: 'feat: implement sister fixture (#42)', files: { 'sister.txt': 'implemented\n' } }],
      },
    ],
    issues: [],
    prs: [],
  })
  try {
    const base = box.sha.main
    const head = box.sha['feat/42-save']
    if (!base || !head) throw new Error('fixture commits missing')
    const current = { repository: 'acme/app', target: 'acme/app#46' }
    const target: FixTarget = {
      ...current,
      number: 46,
      kind: 'pull-request',
      state: 'open',
      candidateGitSHA: head,
      baseGitSHA: base,
    }
    const observe = (sha: string) => {
      const [actual, ...parents] = git(box, box.principal, ['rev-list', '--parents', '-n1', sha]).split(' ')
      if (actual !== sha) throw new Error('Wrong sister fixture commit')
      return {
        sha,
        parents,
        tree: git(box, box.principal, ['rev-parse', `${sha}^{tree}`]),
        subject: git(box, box.principal, ['show', '-s', '--format=%s', sha]),
        paths: git(box, box.principal, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha])
          .split('\n')
          .filter(Boolean),
        config: git(box, box.principal, ['show', `${sha}:.dev/stack.yml`]) + '\n',
      }
    }
    const world = await installedMultiSisterFixture(1, {
      workflow: true,
      currentPr: 46,
      head,
      base,
      commits: [observe(base), observe(head)],
    })
    const assertInitialSpec = async () => {
      const initialRead = await world.operations.readUw(world.context.original)
      if (initialRead.accepted.status !== 'accepted')
        throw new Error(
          `Original canonical Spec unavailable before sister creation: ${JSON.stringify({
            accepted: initialRead.accepted,
            identity: initialRead.identity,
            observation: initialRead.observation,
          })}`,
        )
      const initialEffective = contracts.resolveSpecEffective({
        mode: 'current',
        own: initialRead.accepted.value.ref,
        histories: initialRead.observation.histories,
        graph: initialRead.observation.graph,
      })
      if (!initialEffective.ok)
        throw new Error(`Original current vector unavailable: ${JSON.stringify(initialEffective.diagnostics)}`)
    }
    await assertInitialSpec()
    const created = await world.operations.createSister(world.request(0))
    assert.equal(created.status, 'created', JSON.stringify(created))
    const sister = world.issues.get(43)
    if (!sister) throw new Error('created sister absent')
    await deliverCreatedSister(world)
    sister.state = 'CLOSED'
    sister.stateReason = 'COMPLETED'
    const rawGithub = { cwd: box.principal, gh: world.gh, readAuthor: 'automation' }
    const github = withRoxabiGitHubPolicy(rawGithub)
    const reader = createInstalledUwReadPort(github)
    const live = await readLiveCiEvidence({ cwd: box.principal, target, options: github }, head)
    assert.equal(live.ok, true, JSON.stringify(live))
    if (!live.ok) throw new Error('fixture native check read failed')
    const exactInputs = {
      candidateGitSHA: head,
      scope: current,
      failedChecks: live.value.failedChecks,
      evidenceDigest: live.value.evidenceDigest,
      failures: live.value.failures,
    }
    const captured = acceptedActionInputs(world.mandate, 'attribute-ci')
    const manifest = {
      ...captured.manifest,
      code: { repository: current.repository, base, head, referenceCommit: base },
      subject: {
        kind: 'uw' as const,
        uw: world.mandate.payload.ownSpec.uw,
        pullRequest: current,
        binding: {
          source: 'record' as const,
          record: { scope: current, kind: 'workflow-binding' as const, recordId: world.currentBinding.recordId },
          selector: '/payload',
          digest: contracts.canonicalValueDigest(world.currentBinding.payload),
        },
      },
      operands: { action: 'attribute-ci' as const, exactInputs },
    }
    const inputs = { ...captured, manifest, fingerprint: actionInputDigest(manifest) }
    const mandate = { scope: world.context.original, recordId: world.mandate.recordId, kind: 'mandate' as const }
    const common = {
      format: 'omp-build-action-receipt/2' as const,
      action: 'attribute-ci' as const,
      actionId: 'fixture-ci-action',
      mandate,
      inputs,
      exactInputs,
    }
    const start = contracts.buildRecord({
      version: 1,
      ...current,
      recordId: 'fixture-ci-start',
      runId: 'fixture-ci',
      operationId: 'fixture-ci-start',
      kind: 'action-receipt',
      payload: { ...common, phase: 'start' },
    })
    const resultRecord = contracts.buildRecord({
      version: 1,
      ...current,
      recordId: 'fixture-ci-result',
      runId: 'fixture-ci',
      operationId: 'fixture-ci-result',
      kind: 'action-receipt',
      payload: {
        ...common,
        phase: 'result',
        start: { scope: current, recordId: 'fixture-ci-start', kind: 'action-receipt' },
        native: { completion: 'completed', strict: 'valid', raw: null },
        structured: { attribution: 'change', evidence: null },
        admission: null,
        diagnostics: [],
      },
    })
    if (!start.ok || !resultRecord.ok)
      throw new Error(`fixture attribution invalid: ${JSON.stringify({ start, resultRecord })}`)
    const comments = world.comments.get(46)
    const beforeAttribution = await reader.readUw(world.context.original)
    if (!comments) throw new Error('current PR comments missing')
    comments.push(nativeComment(901, wire(start.value)), nativeComment(902, wire(resultRecord.value)))
    const afterAttribution = await reader.readUw(world.context.original)
    const currentRead = await contracts.readComposedWorkflowHistory([current], github)
    if (!currentRead.ok || !currentRead.histories[0]) throw new Error('current PR history unavailable')
    const history = currentRead.histories[0]
    const mismatched = await linkedIssueBinding(target, rawGithub, reader)
    assert.ok(
      !mismatched.ok && mismatched.diagnostics.includes('fix-history-observation-drift'),
      JSON.stringify({
        mismatched,
        before: { accepted: beforeAttribution.accepted, observation: beforeAttribution.observation },
        after: { accepted: afterAttribution.accepted, observation: afterAttribution.observation },
      }),
    )
    const binding = await linkedIssueBinding(target, github, reader)
    assert.equal(binding.ok, true, JSON.stringify(binding))
    if (!binding.ok || binding.value.history === null || binding.value.currentSpec === null)
      throw new Error('fixture must provide an authenticated workflow binding')
    const config = await readEffectiveFixConfig({ cwd: box.principal, commit: head, git: defaultGit() })
    assert.equal(config.ok, true, JSON.stringify(config))
    const read = binding.value.currentSpec.read
    assert.ok(read.histories.some((entry) => entry.source.scope.target === 'acme/app#44'))
    const input = { cwd: box.principal, target, branch: 'feat/42-save', base: 'main', options: github }
    const result = await authorizeFixAction(
      input,
      history,
      binding.value.history,
      binding.value.externalHistories,
      'fix',
      live.value,
      read,
    )
    assert.deepEqual(
      result,
      { ok: true, value: ['unit'] },
      JSON.stringify({
        result,
        acceptedStatus: read.accepted.status,
        observationStatus: read.observation.status,
        causalStatus: read.causalObservation.status,
      }),
    )
    const verifyIsolation = async () => {
      const otherScope = { repository: 'acme/app', target: 'acme/app#77' }
      const original = world.issues.get(42)
      if (!original) throw new Error('Original native issue is unavailable')
      const parsed = contracts.parseIssueSpecBody({
        uw: otherScope,
        raw: contracts.rawSource(otherScope.target, original.body, '2026-10-27T12:00:00Z'),
      })
      if (parsed.status !== 'conformant') throw new Error('Unrelated native Spec is not conformant')
      const unrelated = roxabiWorkflowFixtures()
      const unrelatedMandate = unrelated.featureMandate(otherScope, {
        recordId: 'unrelated-mandate',
        operationId: 'unrelated-operation',
        body: original.body,
        ownSpec: unrelated.ownSpecFromSnapshot(otherScope, parsed.snapshot),
      })
      const unrelatedSeed = unrelated.historyFrom([unrelatedMandate], 'automation')
      world.issues.set(77, {
        title: 'Unrelated UW',
        body: original.body,
        labels: ['size:S'],
        parent: null,
        blockers: [],
        state: 'OPEN',
        stateReason: null,
      })
      world.comments.set(
        77,
        unrelatedSeed.source.comments.map((comment, index) => nativeComment(7700 + index, comment.body)),
      )
      const unrelatedRead = await contracts.readComposedWorkflowHistory([otherScope], github)
      if (!unrelatedRead.ok || !unrelatedRead.histories[0]) throw new Error('Unrelated native history is unavailable')
      await checkAuthorityIsolation(
        { ...input, uw: reader, readHistory: async () => history },
        world.mandate.recordId,
        unrelatedRead.histories[0],
      )
    }
    await verifyIsolation()
    const correctionInput = {
      ...input,
      uw: reader,
      readHistory: async () => history,
      attributionRecordId: 'fixture-ci-result',
      workflow: { nextReviewStep: async () => ({ action: 'fix' as const, reason: 'ci-failed' }) },
    }
    const admitted = await admitAttributedCiCorrection(correctionInput)
    assert.ok(admitted.ok && admitted.value.status === 'attributed-correction', JSON.stringify(admitted))
    assert.deepEqual(admitted.value.failedChecks, ['unit'])
    world.setFailedCheck('integration')
    const stale = await admitAttributedCiCorrection(correctionInput)
    assert.ok(!stale.ok && stale.diagnostics.includes('ci-attribution-stale'), JSON.stringify(stale))
  } finally {
    rmSync(box.root, { recursive: true, force: true })
  }
}

await main()
