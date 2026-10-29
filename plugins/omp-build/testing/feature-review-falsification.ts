import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { actionInputManifestSchema } from '../engine/action-input-schema.ts'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type { ReviewDriver } from './native-review-driver.ts'
import type { SimState } from './sandbox/sandbox-types.ts'

const guardId = 'selected-region-guard'
const intendedScenario = 'saving after a region selection retains that region'
export const restoredSave = 'export function save(region: string) { return region }\n'
const removedSave = 'export function save(_region: string) { return "stale-region" }\n'
export const guardCommand = `bun -e 'import { save } from "./src/save.ts"; const actual = save("selected-region"); if (actual !== "selected-region") throw new Error("wrong saved region: " + actual); console.log("saved region: " + actual)'`

export function correctionCriteria(task: NativeTask, commit: string) {
  const spec = task.action.inputs.manifest.spec
  if (spec.kind !== 'accepted') throw new Error('correction-fixture-accepted-spec-missing')
  return spec.effective.spec.criteria.map((criterion) => {
    const target = {
      format: 'omp-build-finding-target/1',
      kind: 'criterion',
      spec: spec.effective.own,
      id: criterion.id,
    }
    return {
      target,
      verification: 'evidence',
      evidence: [
        {
          id: `correction-${criterion.id}`,
          target,
          method: 'test',
          scenario: intendedScenario,
          after: {
            toolCallId: `${task.name}-proof`,
            versionClaim: {
              code: { repository: task.action.inputs.manifest.code.repository, commit },
              reason: 'The probe imports src/save.ts from this action worktree after the corrective commit.',
              references: [],
            },
          },
          before: null,
        },
      ],
    }
  })
}

export async function settleOwnedCorrectionFalsification(
  driver: ReviewDriver,
  cwd: string,
  head: string,
  priorHead: string,
) {
  const snapshots: Array<{
    agent: string
    actionId: string
    head: string
    priorHead: string
    fingerprint: string
    index: string
  }> = []
  const recordSnapshot = (task: NativeTask) => {
    const index = task.action.snapshot.indexPath
    const manifest = actionInputManifestSchema.parse(
      JSON.parse(readFileSync(path.join(path.dirname(index), 'manifest.json'), 'utf8')),
    )
    const stateFile = process.env.GH_SIM_STATE
    if (stateFile === undefined) throw new Error('gh-state-missing')
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as SimState
    const prHead = state.prs['7']?.headRefOid
    const fingerprint = task.action.inputs.fingerprint
    if (
      manifest.code.head !== head ||
      task.action.inputs.manifest.code.head !== head ||
      prHead !== priorHead ||
      !readFileSync(index, 'utf8').includes(`Fingerprint: ${fingerprint}\n`)
    )
      throw new Error('correction-fixture-postapply-snapshot-mismatch')
    snapshots.push({
      agent: task.agent,
      actionId: task.action.snapshot.actionId,
      head: manifest.code.head,
      priorHead: prHead,
      fingerprint,
      index,
    })
  }
  const restored = driver.fixTransition(driver.messages.length)
  await driver.settleAction(
    (task) => {
      recordSnapshot(task)
      return {
        facts: [
          {
            guardId,
            removed: true,
            intendedScenario,
            proofFailed: true,
            proofToolCallId: `${task.name}-proof`,
            proofUnavailableReason: null,
          },
        ],
        skippedReason: null,
        commands: [],
      }
    },
    {
      command: guardCommand,
      program: 'bash',
      args: ['-c', guardCommand],
      prepare: () => writeFileSync(path.join(cwd, 'src/save.ts'), removedSave),
      restore: () => writeFileSync(path.join(cwd, 'src/save.ts'), restoredSave),
    },
  )
  if ((await restored) !== 'next-batch') throw new Error('falsification-restored-proof-not-announced')
  const reviewAfter = driver.messages.length
  const terminal = driver.fixTerminal()
  await driver.settleAction(
    (task) => {
      recordSnapshot(task)
      return {
        outcome: 'applied',
        commitSHAs: [],
        commands: [],
        proofToolCallId: `${task.name}-proof`,
        proofUnavailableReason: null,
        proofPaths: [],
        criteria: correctionCriteria(task, task.action.inputs.manifest.code.head),
        guardInventory: [],
      }
    },
    { command: guardCommand, program: 'bash', args: ['-c', guardCommand] },
  )
  return { terminal: await terminal, snapshots, reviewAfter }
}
