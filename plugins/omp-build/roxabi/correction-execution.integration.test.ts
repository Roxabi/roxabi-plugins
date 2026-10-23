import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { Json } from '../dist/contracts.js'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeChildResult,
  NativeTask,
} from '../omp/review-runtime'
import {
  type CorrectionActionBinding,
  type CorrectionEffectResult,
  createNativeCorrectionExecution,
  type NativeCorrectionPort,
} from './correction-execution'
import type { CorrectionCause } from './fix-domain'

let workspace: string | undefined
let remoteWorkspace: string | undefined

const cause: CorrectionCause = {
  id: 'RC-guard',
  title: 'restore the guard',
  mechanism: 'the persisted value bypasses validation',
  fix: 'validate before persistence',
  failure: 'invalid value reaches persistence',
  restored: 'invalid value is rejected',
  paths: ['src/guard.txt'],
  proof: 'repository guard proof',
  findingIds: ['finding-1'],
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function bash(cwd: string, command: string): { exitCode: number; result: Json } {
  try {
    const stdout = execFileSync('bash', ['-lc', command], { cwd, encoding: 'utf8' })
    return { exitCode: 0, result: { stdout } }
  } catch (error) {
    const detail = error as { status?: number; stdout?: string; stderr?: string }
    return { exitCode: detail.status ?? 1, result: { stdout: detail.stdout ?? '', stderr: detail.stderr ?? '' } }
  }
}

function child(
  task: NativeTask,
  structured: Json,
  proof: { id: string; exitCode: number; result: Json; guardId: string | null },
  cwd: string,
): NativeChildResult {
  return {
    id: task.name,
    expectedId: task.name,
    submissions: [{ attemptIndex: 0, data: structured, raw: { yield: structured }, partialText: null }],
    proofEvidence:
      task.proofEvidence === undefined
        ? null
        : {
            ...task.proofEvidence,
            guardId: proof.guardId,
            call: {
              toolCallId: proof.id,
              input: { command: 'bash -lc repository-proof', cwd: '.' },
              effectiveCwd: cwd,
              result: proof.result,
              exitCode: proof.exitCode,
            },
          },
    raw: { id: task.name, structured },
    partialText: null,
    structured,
    usable: true,
    reason: null,
  }
}

function native(
  cwd: string,
  fixture: { proofOnlyPath?: string; reportedProofPaths?: string[] } = {},
): NativeCorrectionPort {
  let active: NativeBatch | null = null
  let callbacks: NativeBatchCallbacks | null = null
  return {
    active: () => active,
    activate(batch, next) {
      active = batch
      callbacks = next
    },
    async stopOwned(batch, reason) {
      const activeCallbacks = callbacks
      if (active !== batch || activeCallbacks === null) return
      active = null
      await activeCallbacks.onStop(reason, { batch, children: [], raw: { stopped: reason }, complete: false })
    },
    async announce(batch) {
      const task = batch.tasks.tasks[0]
      const activeCallbacks = callbacks
      if (!task || activeCallbacks === null) throw new Error('test native batch unavailable')
      let structured: Json
      let proof: { id: string; exitCode: number; result: Json; guardId: string | null }
      if (task.proofEvidence?.purpose === 'fix-apply') {
        if (fixture.proofOnlyPath) {
          const proofPath = join(cwd, fixture.proofOnlyPath)
          mkdirSync(dirname(proofPath), { recursive: true })
          writeFileSync(proofPath, '#!/usr/bin/env bash\ntest -f src/guard.txt\n')
          git(cwd, ['add', '--', fixture.proofOnlyPath])
          git(cwd, ['commit', '-m', 'add guard proof'])
        } else {
          writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: restored\n')
          git(cwd, ['add', '--', 'src/guard.txt'])
          git(cwd, ['commit', '-m', 'fix guard'])
        }
        const run = bash(cwd, 'test -f src/guard.txt')
        structured = {
          outcome: 'applied',
          commitSHAs: [git(cwd, ['rev-parse', 'HEAD'])],
          commands: [],
          proofPaths: fixture.reportedProofPaths ?? [],
          guardInventory: [
            {
              guardId: 'persist-guard-a',
              productionGuard: 'reject invalid persisted value',
              paths: ['src/guard.txt'],
              intendedScenario: cause.failure,
            },
            {
              guardId: 'persist-guard-b',
              productionGuard: 'reject a stale persisted value',
              paths: ['src/guard.txt'],
              intendedScenario: cause.failure,
            },
          ],
          proofToolCallId: 'apply-proof',
          proofUnavailableReason: null,
        }
        proof = { id: 'apply-proof', guardId: null, ...run }
      } else if (task.proofEvidence?.purpose === 'fix-falsify') {
        const guardId = task.task.includes('persist-guard-b') ? 'persist-guard-b' : 'persist-guard-a'
        writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: removed\n')
        const run = bash(cwd, 'test "$(cat src/guard.txt)" = "guard: restored"')
        writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: restored\n')
        structured = {
          facts: [
            {
              guardId,
              removed: true,
              intendedScenario: cause.failure,
              proofFailed: true,
              proofToolCallId: `perturbed-proof-${guardId}`,
              proofUnavailableReason: null,
            },
          ],
          skippedReason: null,
          commands: [],
        }
        proof = { id: `perturbed-proof-${guardId}`, guardId, ...run }
      } else {
        const run = bash(cwd, 'test "$(cat src/guard.txt)" = "guard: restored"')
        structured = {
          outcome: 'applied',
          commitSHAs: [],
          commands: [],
          proofPaths: [],
          guardInventory: [],
          proofToolCallId: 'restored-proof',
          proofUnavailableReason: null,
        }
        proof = { id: 'restored-proof', guardId: null, ...run }
      }
      active = null
      const result: NativeBatchResult = {
        batch,
        children: [child(task, structured, proof, cwd)],
        raw: { native: task.name },
        complete: true,
      }
      await activeCallbacks.onComplete(result)
    },
  }
}

function workspaceForTest(): {
  cwd: string
  head: string
  publishBinding: {
    pushUrl: string
    publicationRepository: string
    localBranch: string
    destinationRef: string
    localHead: string
    expectedRemoteSHA: string
    defaultBranch: string
    observed: Json
  }
} {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-correction-execution-'))
  workspace = cwd
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'test@example.com'])
  git(cwd, ['config', 'user.name', 'Test User'])
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: missing\n')
  git(cwd, ['add', '--', 'src/guard.txt'])
  git(cwd, ['commit', '-m', 'initial'])
  const defaultBranch = git(cwd, ['branch', '--show-current'])
  git(cwd, ['checkout', '-b', 'fix-smoke'])
  const head = git(cwd, ['rev-parse', 'HEAD'])
  const pushUrl = mkdtempSync(join(tmpdir(), 'omp-correction-remote-'))
  remoteWorkspace = pushUrl
  git(pushUrl, ['init', '--bare'])
  git(cwd, ['remote', 'add', 'origin', pushUrl])
  git(cwd, ['push', '--set-upstream', 'origin', 'HEAD:refs/heads/fix-smoke'])
  return {
    cwd,
    head,
    publishBinding: {
      pushUrl,
      publicationRepository: 'Acme/app',
      localBranch: 'fix-smoke',
      destinationRef: 'refs/heads/fix-smoke',
      localHead: head,
      expectedRemoteSHA: head,
      defaultBranch,
      observed: { source: 'integration-fixture' },
    },
  }
}

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true })
  if (remoteWorkspace) rmSync(remoteWorkspace, { recursive: true, force: true })
  workspace = undefined
  remoteWorkspace = undefined
})

describe('native correction execution', () => {
  it('requires every inventory guard to receive a perturbed and restored actual proof', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    const conserved: NativeBatchResult[] = []
    const bindings: CorrectionActionBinding[] = []
    const executor = createNativeCorrectionExecution({
      native: native(cwd),
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-1',
      decisionId: 'decision-1',
      signal: new AbortController().signal,
      async bindAction(binding: CorrectionActionBinding): Promise<
        CorrectionEffectResult<{
          batch: NativeBatch
          conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
        }>
      > {
        bindings.push(binding)
        const batch: NativeBatch = {
          operationId: 'operation-1',
          tasks: { context: binding.task.task, tasks: [binding.task] },
        }
        return {
          ok: true,
          value: {
            batch,
            async conserve(result) {
              conserved.push(result)
              return { ok: true, value: { contributionIds: [result.batch.tasks.tasks[0]?.name ?? 'missing'] } }
            },
          },
        }
      },
      async onStarted() {
        return { ok: true, value: undefined }
      },
    })

    const applied = await executor.apply(cause, 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply should have committed')
    const falsification = await executor.falsify(cause, applied.value.commitSHAs)
    expect(falsification).toMatchObject({
      ok: true,
      value: {
        facts: [
          { guardId: 'persist-guard-a', proofFailedIntendedScenario: true },
          { guardId: 'persist-guard-b', proofFailedIntendedScenario: true },
        ],
      },
    })
    expect(conserved.map((result) => result.batch.tasks.tasks[0]?.proofEvidence?.occurrence)).toEqual([
      'apply',
      'perturbed',
      'restored',
      'perturbed',
      'restored',
    ])
    const applyBinding = bindings[0]
    expect(applyBinding?.context).toMatchObject({
      causeJSON: JSON.stringify(cause),
      proofPaths: [],
      priorApplyProof: null,
    })
    for (const binding of bindings.slice(1)) {
      expect(binding.context).toMatchObject({
        causeJSON: JSON.stringify(cause),
        proofPaths: [],
        priorApplyProof: { toolCallId: 'apply-proof', input: { command: 'bash -lc repository-proof', cwd: '.' } },
      })
      expect(binding.contextRefs).toContain(applyBinding?.task.name)
    }
    expect(bindings[2]?.contextRefs).toContain(bindings[1]?.task.name)
    expect(bindings[4]?.contextRefs).toContain(bindings[3]?.task.name)
    expect(git(cwd, ['status', '--porcelain'])).toBe('')
  })

  for (const scenario of [
    {
      label: 'accepts an explicitly declared proof implementation path',
      proofPaths: ['test/guard-proof.sh'],
      accepted: true,
    },
    { label: 'rejects the same unlisted proof implementation path', proofPaths: [], accepted: false },
  ]) {
    it(scenario.label, async () => {
      const { cwd, head, publishBinding } = workspaceForTest()
      const conserved: NativeBatchResult[] = []
      const executor = createNativeCorrectionExecution({
        native: native(cwd, { proofOnlyPath: 'test/guard-proof.sh', reportedProofPaths: scenario.proofPaths }),
        prepared: {
          cwd,
          target: {
            repository: 'Acme/app',
            target: 'Acme/app#42',
            number: 42,
            kind: 'pull-request',
            state: 'open',
            candidateGitSHA: head,
          },
          publishBinding,
        },
        operationId: 'operation-proof-paths',
        decisionId: 'decision-proof-paths',
        signal: new AbortController().signal,
        async bindAction(binding: CorrectionActionBinding): Promise<
          CorrectionEffectResult<{
            batch: NativeBatch
            conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
          }>
        > {
          const batch: NativeBatch = {
            operationId: 'operation-proof-paths',
            tasks: { context: binding.task.task, tasks: [binding.task] },
          }
          return {
            ok: true,
            value: {
              batch,
              async conserve(result) {
                conserved.push(result)
                return { ok: true, value: { contributionIds: [result.batch.tasks.tasks[0]?.name ?? 'missing'] } }
              },
            },
          }
        },
        async onStarted() {
          return { ok: true, value: undefined }
        },
      })

      const applied = await executor.apply(cause, 1)
      expect(applied.ok).toBe(scenario.accepted)
      expect(conserved).toHaveLength(1)
      expect(git(cwd, ['status', '--porcelain'])).toBe('')
      if (scenario.accepted) {
        if (!applied.ok) throw new Error('declared proof path should be accepted')
        expect(git(cwd, ['rev-parse', 'HEAD'])).toBe(applied.value.commitSHAs[0])
      } else {
        expect(applied).toMatchObject({
          ok: false,
          kind: 'terminal',
          diagnostics: ['native-apply-git-state-unverified'],
        })
        expect(git(cwd, ['rev-parse', 'HEAD'])).not.toBe(head)
      }
    })
  }

  it('refuses a default-branch publication binding before native work', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    let announced = false
    const executor = createNativeCorrectionExecution({
      native: {
        active: () => null,
        activate() {
          announced = true
        },
        async stopOwned() {},
        async announce() {
          announced = true
        },
      },
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding: {
          ...publishBinding,
          localBranch: publishBinding.defaultBranch,
          destinationRef: `refs/heads/${publishBinding.defaultBranch}`,
        },
      },
      operationId: 'operation-default-branch',
      decisionId: 'decision-default-branch',
      signal: new AbortController().signal,
      async bindAction() {
        throw new Error('invalid publication must fail before action binding')
      },
      async onStarted() {
        throw new Error('invalid publication must fail before native start')
      },
    })

    await expect(executor.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      kind: 'terminal',
      diagnostics: ['publish-binding-invalid'],
    })
    expect(announced).toBe(false)
  })

  it('refuses a publication binding whose effective origin push URL differs', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    const wrongRemote = mkdtempSync(join(tmpdir(), 'omp-correction-wrong-remote-'))
    remoteWorkspace = wrongRemote
    git(wrongRemote, ['init', '--bare'])
    git(cwd, ['remote', 'set-url', '--push', 'origin', wrongRemote])
    let announced = false
    const executor = createNativeCorrectionExecution({
      native: {
        active: () => null,
        activate() {
          announced = true
        },
        async stopOwned() {},
        async announce() {
          announced = true
        },
      },
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-wrong-upstream',
      decisionId: 'decision-wrong-upstream',
      signal: new AbortController().signal,
      async bindAction() {
        throw new Error('stale publication must fail before action binding')
      },
      async onStarted() {
        throw new Error('stale publication must fail before native start')
      },
    })

    await expect(executor.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      kind: 'terminal',
      diagnostics: ['publish-binding-stale'],
    })
    expect(announced).toBe(false)
  })

  it('publishes only the owned SHA to the captured destination and verifies it remotely', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    const executor = createNativeCorrectionExecution({
      native: native(cwd),
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-push',
      decisionId: 'decision-push',
      signal: new AbortController().signal,
      async bindAction(binding: CorrectionActionBinding): Promise<
        CorrectionEffectResult<{
          batch: NativeBatch
          conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
        }>
      > {
        const batch: NativeBatch = {
          operationId: 'operation-push',
          tasks: { context: binding.task.task, tasks: [binding.task] },
        }
        return {
          ok: true,
          value: {
            batch,
            async conserve() {
              return { ok: true, value: { contributionIds: [binding.task.name] } }
            },
          },
        }
      },
      async onStarted() {
        return { ok: true, value: undefined }
      },
    })

    const applied = await executor.apply(cause, 1)
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('apply should commit before publication')
    const published = await executor.push()
    expect(published.ok).toBe(true)
    expect(git(publishBinding.pushUrl, ['rev-parse', 'refs/heads/fix-smoke'])).toBe(applied.value.commitSHAs[0])
    expect(() =>
      git(publishBinding.pushUrl, ['show-ref', '--verify', '--quiet', `refs/heads/${publishBinding.defaultBranch}`]),
    ).toThrow()
  })
  it('refuses a pause between correction stages and immediately before a host push', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    let bound = 0
    const executor = createNativeCorrectionExecution({
      native: native(cwd),
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-paused',
      decisionId: 'decision-paused',
      signal: new AbortController().signal,
      async authorizeContinuation() {
        return { ok: false, diagnostics: ['fix-mandate-refused:paused'] }
      },
      async bindAction() {
        bound += 1
        throw new Error('paused correction must not bind an action')
      },
      async onStarted() {
        throw new Error('paused correction must not start native work')
      },
    })

    await expect(executor.apply(cause, 1)).resolves.toMatchObject({
      ok: false,
      diagnostics: ['fix-mandate-refused:paused'],
    })
    await expect(executor.push()).resolves.toMatchObject({
      ok: false,
      diagnostics: ['fix-mandate-refused:paused'],
    })
    expect(bound).toBe(0)
    expect(git(publishBinding.pushUrl, ['rev-parse', publishBinding.destinationRef])).toBe(head)
  })
  it('rechecks the local abort fence after authority awaits', async () => {
    const { cwd, head, publishBinding } = workspaceForTest()
    const controller = new AbortController()
    const gate = Promise.withResolvers<{ ok: true; value: undefined }>()
    const entered = Promise.withResolvers<void>()
    let bound = 0
    const executor = createNativeCorrectionExecution({
      native: native(cwd),
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-authority-race',
      decisionId: 'decision-authority-race',
      signal: controller.signal,
      authorizeContinuation: () => {
        entered.resolve()
        return gate.promise
      },
      async bindAction() {
        bound += 1
        throw new Error('aborted correction must not bind an action')
      },
      async onStarted() {
        throw new Error('aborted correction must not start native work')
      },
    })

    const pending = executor.apply(cause, 1)
    await entered.promise
    controller.abort()
    gate.resolve({ ok: true, value: undefined })

    await expect(pending).resolves.toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })

    const pushController = new AbortController()
    const pushGate = Promise.withResolvers<{ ok: true; value: undefined }>()
    const pushEntered = Promise.withResolvers<void>()
    const pushExecutor = createNativeCorrectionExecution({
      native: native(cwd),
      prepared: {
        cwd,
        target: {
          repository: 'Acme/app',
          target: 'Acme/app#42',
          number: 42,
          kind: 'pull-request',
          state: 'open',
          candidateGitSHA: head,
        },
        publishBinding,
      },
      operationId: 'operation-push-authority-race',
      decisionId: 'decision-push-authority-race',
      signal: pushController.signal,
      authorizeContinuation: () => {
        pushEntered.resolve()
        return pushGate.promise
      },
      async bindAction() {
        throw new Error('push-only race must not bind an action')
      },
      async onStarted() {
        throw new Error('push-only race must not start native work')
      },
    })
    const pendingPush = pushExecutor.push()
    await pushEntered.promise
    pushController.abort()
    pushGate.resolve({ ok: true, value: undefined })

    await expect(pendingPush).resolves.toMatchObject({ ok: false, diagnostics: ['fix-run-aborted'] })
    expect(git(publishBinding.pushUrl, ['rev-parse', publishBinding.destinationRef])).toBe(head)
    expect(bound).toBe(0)
  })
})
