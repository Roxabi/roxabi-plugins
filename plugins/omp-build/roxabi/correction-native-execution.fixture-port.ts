import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Json } from '../dist/contracts.js'
import type {
  NativeBatch,
  NativeBatchCallbacks,
  NativeChildResult,
  NativeTask,
} from '../omp/review-runtime/contracts.js'
import type { NativeCorrectionPort } from './correction-execution-contract'
import { bash, cause, git } from './correction-native-execution.fixture-world'

function child(
  task: NativeTask,
  structured: Json,
  proof: { id: string; command: string; exitCode: number; result: Json; guardId: string | null },
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
              input: { command: proof.command, cwd: '.' },
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

export function native(
  cwd: string,
  options: { proofOnlyPath?: string; reportedProofPaths?: string[] } = {},
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
      if (active !== batch || callbacks === null) return
      active = null
      await callbacks.onStop(reason, { batch, children: [], raw: { stopped: reason }, complete: false })
    },
    async announce(batch) {
      const task = batch.tasks.tasks[0]
      if (!task || callbacks === null) throw new Error('test native batch unavailable')

      let structured: Json
      let proof: { id: string; command: string; exitCode: number; result: Json; guardId: string | null }
      if (task.proofEvidence?.purpose === 'fix-apply') {
        if (options.proofOnlyPath) {
          const path = join(cwd, options.proofOnlyPath)
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(path, '#!/usr/bin/env bash\ntest -f src/guard.txt\n')
          git(cwd, ['add', '--', options.proofOnlyPath])
          git(cwd, ['commit', '-m', 'add guard proof'])
        } else {
          writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: restored\n')
          git(cwd, ['add', '--', 'src/guard.txt'])
          git(cwd, ['commit', '-m', 'fix guard'])
        }
        const command = 'test -f src/guard.txt'
        const run = bash(cwd, command)
        structured = {
          outcome: 'applied',
          commitSHAs: [git(cwd, ['rev-parse', 'HEAD'])],
          commands: [],
          proofPaths: options.reportedProofPaths ?? [],
          guardInventory: [
            {
              guardId: 'persist-guard-a',
              productionGuard: 'reject invalid persisted value',
              paths: ['src/guard.txt'],
              intendedScenario: cause.failure,
            },
            {
              guardId: 'persist-guard-b',
              productionGuard: 'reject stale persisted value',
              paths: ['src/guard.txt'],
              intendedScenario: cause.failure,
            },
          ],
          proofToolCallId: 'apply-proof',
          proofUnavailableReason: null,
        }
        proof = { id: 'apply-proof', command, guardId: null, ...run }
      } else if (task.proofEvidence?.purpose === 'fix-falsify') {
        const guardId = task.task.includes('persist-guard-b') ? 'persist-guard-b' : 'persist-guard-a'
        writeFileSync(join(cwd, 'src', 'guard.txt'), 'guard: removed\n')
        const command = 'test "$(cat src/guard.txt)" = "guard: restored"'
        const run = bash(cwd, command)
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
        proof = { id: `perturbed-proof-${guardId}`, command, guardId, ...run }
      } else {
        const command = 'test "$(cat src/guard.txt)" = "guard: restored"'
        const run = bash(cwd, command)
        structured = {
          outcome: 'applied',
          commitSHAs: [],
          commands: [],
          proofPaths: [],
          guardInventory: [],
          proofToolCallId: 'restored-proof',
          proofUnavailableReason: null,
        }
        proof = { id: 'restored-proof', command, guardId: null, ...run }
      }

      active = null
      await callbacks.onComplete(
        {
          batch,
          children: [child(task, structured, proof, cwd)],
          raw: { native: task.name },
          complete: true,
        },
        () => true,
      )
    },
  }
}

export function nativeMustNotStart(): NativeCorrectionPort {
  return {
    active: () => null,
    activate() {
      throw new Error('publication binding must fail before native activation')
    },
    async announce() {
      throw new Error('publication binding must fail before native announcement')
    },
    async stopOwned() {},
  }
}
