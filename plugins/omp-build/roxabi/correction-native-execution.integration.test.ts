import { afterEach, describe, expect, it } from 'vitest'

import type { NativeBatchResult } from '../omp/review-runtime/contracts.js'
import type { CorrectionActionBinding } from './correction-execution-contract'
import { native } from './correction-native-execution.fixture-port'
import { executor } from './correction-native-execution.fixture-runner'
import { cause, cleanupWorkspaces, git, workspace } from './correction-native-execution.fixture-world'

afterEach(cleanupWorkspaces)

describe('native correction execution', () => {
  it('requires every inventory guard to receive a perturbed and restored actual proof', async () => {
    const fixture = workspace()
    const bindings: CorrectionActionBinding[] = []
    const conserved: NativeBatchResult[] = []
    const run = executor(fixture, native(fixture.cwd), 'operation-1', bindings, conserved)

    const applied = await run.apply(cause, 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply must succeed')

    const falsification = await run.falsify(cause, applied.value.commitSHAs)
    expect(falsification).toMatchObject({
      ok: true,
      value: {
        facts: [
          { guardId: 'persist-guard-a', proofFailedIntendedScenario: true },
          { guardId: 'persist-guard-b', proofFailedIntendedScenario: true },
        ],
      },
    })
    expect(applied.value.contributionIds).toEqual([bindings[0]?.task.name])
    expect(conserved.map((item) => item.batch.tasks.tasks[0]?.proofEvidence?.occurrence)).toEqual([
      'apply',
      'perturbed',
      'restored',
      'perturbed',
      'restored',
    ])

    const applyBinding = bindings[0]
    expect(applyBinding?.contextRefs).toEqual(['decision-1'])
    expect(applyBinding?.context).toEqual({ recordIds: ['decision-1'], attempt: 1 })
    expect(bindings).toHaveLength(5)
    expect(conserved).toHaveLength(bindings.length)
    for (const [index, binding] of bindings.entries()) {
      const consumer = conserved[index]?.batch.tasks.tasks[0]
      expect(consumer).toEqual(binding.task)
      expect(consumer?.task).toContain(`Index: ${binding.task.action.snapshot.indexPath}`)
      expect(consumer?.task).toContain('Read only that index and the files it names.')
      expect(conserved[index]?.children[0]).toMatchObject({
        id: binding.task.name,
        expectedId: binding.task.name,
        usable: true,
      })
    }
    for (const binding of bindings.slice(1)) {
      expect(binding.contextRefs).toContain('decision-1')
      expect(binding.contextRefs).toContain(applyBinding?.task.name)
    }
    expect(bindings[2]?.contextRefs).toContain(bindings[1]?.task.name)
    expect(bindings[4]?.contextRefs).toContain(bindings[3]?.task.name)
    expect(conserved.map((item) => item.children[0]?.proofEvidence)).toMatchObject([
      { causeId: cause.id, occurrence: 'apply', call: { toolCallId: 'apply-proof', exitCode: 0 } },
      {
        causeId: cause.id,
        occurrence: 'perturbed',
        guardId: 'persist-guard-a',
        call: { toolCallId: 'perturbed-proof-persist-guard-a', exitCode: 1 },
      },
      { causeId: cause.id, occurrence: 'restored', call: { toolCallId: 'restored-proof', exitCode: 0 } },
      {
        causeId: cause.id,
        occurrence: 'perturbed',
        guardId: 'persist-guard-b',
        call: { toolCallId: 'perturbed-proof-persist-guard-b', exitCode: 1 },
      },
      { causeId: cause.id, occurrence: 'restored', call: { toolCallId: 'restored-proof', exitCode: 0 } },
    ])
    expect(conserved.map((item) => item.children[0]?.proofEvidence?.call?.input)).toEqual([
      { command: 'test -f src/guard.txt', cwd: '.' },
      ...Array.from({ length: 4 }, () => ({
        command: 'test "$(cat src/guard.txt)" = "guard: restored"',
        cwd: '.',
      })),
    ])
    expect(git(fixture.cwd, ['status', '--porcelain'])).toBe('')
  })

  it('pins each action to its observed clean start without changing the original publication anchor', async () => {
    const fixture = workspace()
    const bindings: CorrectionActionBinding[] = []
    const run = executor(fixture, native(fixture.cwd), 'operation-action-heads', bindings)
    const applied = await run.apply(cause, 1)
    if (!applied.ok) throw new Error('apply must succeed')
    const head = applied.value.commitSHAs[0]
    expect(head).toBeDefined()
    expect(head).not.toBe(fixture.head)
    await expect(run.revalidateRequiredPaths([cause])).resolves.toMatchObject({ ok: true })
    await expect(run.falsify(cause, applied.value.commitSHAs)).resolves.toMatchObject({ ok: true })
    expect(bindings.map((binding) => binding.phase)).toEqual([
      'apply',
      'revalidate',
      'falsify',
      'restore-proof',
      'falsify',
      'restore-proof',
    ])
    expect(bindings.map((binding) => binding.task.action.inputs.manifest.code)).toEqual([
      { repository: 'Acme/app', base: fixture.base, head: fixture.head, referenceCommit: fixture.head },
      ...Array.from({ length: 5 }, () => ({
        repository: 'Acme/app',
        base: fixture.base,
        head,
        referenceCommit: head,
      })),
    ])
    expect(fixture.binding.expectedRemoteSHA).toBe(fixture.head)
  })

  it('refuses an unowned descendant before registering a later correction action', async () => {
    const fixture = workspace()
    const bindings: CorrectionActionBinding[] = []
    const run = executor(fixture, native(fixture.cwd), 'operation-unowned-head', bindings)
    const applied = await run.apply(cause, 1)
    if (!applied.ok) throw new Error('apply must succeed')
    git(fixture.cwd, ['commit', '--allow-empty', '-m', 'external descendant'])
    await expect(run.revalidateRequiredPaths([cause])).resolves.toMatchObject({
      ok: false,
      kind: 'terminal',
      diagnostics: ['fix-head-mismatch'],
    })
    expect(bindings).toHaveLength(1)
  })

  it.each([
    { proofPaths: ['test/guard-proof.sh'], accepted: true },
    { proofPaths: [], accepted: false },
  ])('allows only declared proof implementation paths', async ({ proofPaths, accepted }) => {
    const fixture = workspace()
    const conserved: NativeBatchResult[] = []
    const run = executor(
      fixture,
      native(fixture.cwd, {
        proofOnlyPath: 'test/guard-proof.sh',
        reportedProofPaths: proofPaths,
      }),
      'operation-paths',
      [],
      conserved,
    )

    const applied = await run.apply(cause, 1)
    expect(applied.ok).toBe(accepted)
    expect(conserved).toHaveLength(1)
    expect(git(fixture.cwd, ['status', '--porcelain'])).toBe('')
    if (!accepted)
      expect(applied).toMatchObject({
        ok: false,
        kind: 'terminal',
        diagnostics: ['native-apply-git-state-unverified'],
      })
  })

  it('publishes only the owned head to the captured destination and verifies its readback', async () => {
    const fixture = workspace()
    const run = executor(fixture, native(fixture.cwd), 'operation-push')
    const applied = await run.apply(cause, 1)
    if (!applied.ok) throw new Error('apply must succeed')

    await expect(run.push()).resolves.toMatchObject({
      ok: true,
      value: { head: applied.value.commitSHAs[0] },
    })
    expect(git(fixture.binding.pushUrl, ['rev-parse', fixture.binding.destinationRef])).toBe(
      applied.value.commitSHAs[0],
    )
    expect(() =>
      git(fixture.binding.pushUrl, ['show-ref', '--verify', '--quiet', `refs/heads/${fixture.binding.defaultBranch}`]),
    ).toThrow()
  })

  it('refuses a pause between correction stages and immediately before a host push', async () => {
    const fixture = workspace()
    const bindings: CorrectionActionBinding[] = []
    const run = executor(fixture, native(fixture.cwd), 'operation-paused', bindings, [], {
      signal: new AbortController().signal,
      async authorizeContinuation() {
        return { ok: false, diagnostics: ['fix-mandate-refused:paused'] }
      },
    })

    await expect(run.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      diagnostics: ['fix-mandate-refused:paused'],
    })
    await expect(run.push()).resolves.toMatchObject({
      ok: false,
      diagnostics: ['fix-mandate-refused:paused'],
    })
    expect(bindings).toHaveLength(0)
    expect(git(fixture.binding.pushUrl, ['rev-parse', fixture.binding.destinationRef])).toBe(fixture.head)
  })

  it('fences apply and push after continuation authority resolves into an abort', async () => {
    const fixture = workspace()
    const controller = new AbortController()
    const gate = Promise.withResolvers<{ ok: true; value: undefined }>()
    const entered = Promise.withResolvers<void>()
    const bindings: CorrectionActionBinding[] = []
    const run = executor(fixture, native(fixture.cwd), 'operation-authority-race', bindings, [], {
      signal: controller.signal,
      authorizeContinuation: () => {
        entered.resolve()
        return gate.promise
      },
    })

    const pending = run.apply(cause, 1)
    await entered.promise
    controller.abort()
    gate.resolve({ ok: true, value: undefined })
    await expect(pending).resolves.toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })
    expect(bindings).toHaveLength(0)

    const pushController = new AbortController()
    const pushGate = Promise.withResolvers<{ ok: true; value: undefined }>()
    const pushEntered = Promise.withResolvers<void>()
    const push = executor(fixture, native(fixture.cwd), 'operation-push-authority-race', [], [], {
      signal: pushController.signal,
      authorizeContinuation: () => {
        pushEntered.resolve()
        return pushGate.promise
      },
    }).push()
    await pushEntered.promise
    pushController.abort()
    pushGate.resolve({ ok: true, value: undefined })
    await expect(push).resolves.toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })
    expect(git(fixture.binding.pushUrl, ['rev-parse', fixture.binding.destinationRef])).toBe(fixture.head)
  })
})
