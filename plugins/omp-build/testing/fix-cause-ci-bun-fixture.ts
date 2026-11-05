import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { nativeComment, wire } from '../adapters/__tests__/github-workflow-support.ts'
import * as contracts from '../dist/contracts.js'
import { actionInputDigest } from '../engine/action-input.ts'
import { linkedIssueBinding } from '../roxabi/fix-checkpoint-binding.ts'
import { admitAttributedCiCorrection } from '../roxabi/fix-ci-admission.ts'
import { authorizeFixAction, readLiveCiEvidence } from '../roxabi/fix-ci-evidence.ts'
import type { FixTarget } from '../roxabi/fix-contract.ts'
import { decideFixAuthority } from '../roxabi/fix-mandate-authority.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { readEffectiveFixConfig } from '../roxabi/workflow-config.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { installedMultiSisterFixture } from './multi-sister-installed-fixture.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { sandbox } from './sandbox/sandbox-repository.ts'

async function checkAuthorityIsolation(
  input: Parameters<typeof decideFixAuthority>[0],
  mandateId: string,
): Promise<void> {
  const unrelated = roxabiWorkflowFixtures()
  const unrelatedMandate = unrelated.featureMandate(
    { repository: 'acme/app', target: 'acme/app#77' },
    { recordId: 'unrelated-mandate', operationId: 'unrelated-operation' },
  )
  const unrelatedHistory = unrelated.historyFrom([unrelatedMandate], 'automation')
  const reader = input.uw
  const causalOnlyReader = {
    ...reader,
    readUw: async (scope: { repository: string; target: string }) => {
      const observed = await reader.readUw(scope)
      return { ...observed, histories: [...observed.histories, unrelatedHistory] }
    },
  }
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
    branches: [],
    issues: [],
    prs: [],
  })
  try {
    const head = box.sha.main
    if (!head) throw new Error('fixture commit missing')
    const current = { repository: 'acme/app', target: 'acme/app#46' }
    const target: FixTarget = {
      ...current,
      number: 46,
      kind: 'pull-request',
      state: 'open',
      candidateGitSHA: head,
      baseGitSHA: head,
    }
    const world = await installedMultiSisterFixture(1, { workflow: true, currentPr: 46, head, base: head })
    const created = await world.operations.createSister(world.request(0))
    assert.equal(created.status, 'created', JSON.stringify(created))
    const sister = world.issues.get(43)
    if (!sister) throw new Error('created sister absent')
    sister.state = 'CLOSED'
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
      code: { ...captured.manifest.code, repository: current.repository, head },
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
    if (!comments) throw new Error('current PR comments missing')
    comments.push(nativeComment(901, wire(start.value)), nativeComment(902, wire(resultRecord.value)))
    const currentRead = await contracts.readComposedWorkflowHistory([current], github)
    if (!currentRead.ok || !currentRead.histories[0]) throw new Error('current PR history unavailable')
    const history = currentRead.histories[0]
    const mismatched = await linkedIssueBinding(target, rawGithub, reader)
    assert.ok(
      !mismatched.ok && mismatched.diagnostics.includes('fix-history-observation-drift'),
      JSON.stringify(mismatched),
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
    assert.deepEqual(result, { ok: true, value: ['unit'] }, JSON.stringify(result))
    await checkAuthorityIsolation({ ...input, uw: reader, readHistory: async () => history }, world.mandate.recordId)
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
