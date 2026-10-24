import { writeFileSync } from 'node:fs'
import path from 'node:path'

import type { ReviewDriver } from './native-review-driver.ts'

const guardId = 'selected-region-guard'
const intendedScenario = 'saving after a region selection retains that region'
const restoredSave = 'export const save = "selected-region"\n'
const removedSave = 'export const save = "stale-region"\n'
const guardCommand = 'test "$(cat src/save.ts)" = \'export const save = "selected-region"\''

export async function settleOwnedCorrectionFalsification(driver: ReviewDriver, cwd: string) {
  const restored = driver.fixTransition(driver.messages.length)
  await driver.settleAction(
    (task) => ({
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
    }),
    {
      command: guardCommand,
      program: 'bash',
      args: ['-c', guardCommand],
      prepare: () => writeFileSync(path.join(cwd, 'src/save.ts'), removedSave),
      restore: () => writeFileSync(path.join(cwd, 'src/save.ts'), restoredSave),
    },
  )
  if ((await restored) !== 'next-batch') throw new Error('falsification-restored-proof-not-announced')
  const terminal = driver.fixTerminal()
  await driver.settleAction(
    (task) => ({
      outcome: 'applied',
      commitSHAs: [],
      commands: [],
      proofToolCallId: `${task.name}-proof`,
      proofUnavailableReason: null,
      proofPaths: [],
      guardInventory: [],
    }),
    { command: guardCommand, program: 'bash', args: ['-c', guardCommand] },
  )
  return terminal
}
