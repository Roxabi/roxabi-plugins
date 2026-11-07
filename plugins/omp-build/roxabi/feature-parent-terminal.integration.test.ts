import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import type { Scope } from '../engine/record-values.ts'
import { scopeKey } from '../engine/uw-graph.ts'
import { createEpicDriver, type EpicDriverPort } from '../skills/feature/epic-driver.ts'
import { withEpicEffects } from '../skills/feature/epic-driver-runtime.ts'
import { runNestedDeliveryScenario } from '../testing/nested-delivery-world.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import { continueFeature } from './workflow.ts'

async function prepareCompletedMiddle(
  driver: EpicDriverPort,
  operations: UwOperations,
  cwd: string,
  middle: Scope,
  range: string,
) {
  let step = await driver.readEpicStep(cwd, 203)
  if (step.step.action === 'final-review' && step.step.stage === 'review') {
    const current = await operations.readUw(middle)
    const decisions = current.histories
      .filter((history) => history.source.scope.target === middle.target)
      .flatMap((history) => history.operations)
      .filter((operation) => operation.status === 'complete' && operation.record?.kind === 'decision')
    if (decisions.length !== 1 || decisions[0]?.record?.kind !== 'decision')
      throw new Error('Expected one observed middle review decision')
    expect(step.step.range).toBe(range)
    await driver.review(cwd, 203, decisions[0].record.recordId, range)
    step = await driver.readEpicStep(cwd, 203)
  }
  if (step.name === 'post-merge') {
    await driver.hook(cwd, 203)
    step = await driver.readEpicStep(cwd, 203)
  }
  expect(step.name, JSON.stringify(step)).toBe('complete')
}

function expectContinuation(
  result: ContinueFeatureResult,
  mode: string,
  root: Scope,
  middle: Scope,
  mandateId: string,
) {
  if (mode === 'complete') {
    expect(result.kind, JSON.stringify(result)).toBe('action')
    if (result.kind !== 'action') throw new Error(`Root continuation did not start: ${JSON.stringify(result)}`)
    expect(result.start.scope).toEqual(root)
    const source = result.followUp.tasks.tasks[0]?.action.inputs.manifest.acceptedSources
    expect(source).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: expect.objectContaining({ scope: root, recordId: mandateId, kind: 'mandate' }),
        }),
      ]),
    )
  } else if (result.kind === 'action') {
    expect(result.start.scope).toEqual(middle)
  } else if (result.kind === 'epic-final-review') {
    expect(result.review.context.number).toBe(203)
  } else {
    expect(result.kind, JSON.stringify(result)).toBe('blocked')
  }
}

it.each(['complete', 'middle-missing-coverage'] as const)(
  'routes a nested parent terminal from genuinely observed completion: %s',
  async (mode) => {
    await runNestedDeliveryScenario(
      mode,
      undefined,
      async ({ world, root, middle, rootMandate, middleMandate, proof }) => {
        const before = await world.operations.readUw(root)
        const middleCompletion = before.completion.completions.get(scopeKey(middle))
        if (mode === 'complete') {
          expect(middleCompletion).toMatchObject({ state: 'complete', role: 'parent' })
          expect(before.completion.completions.get(scopeKey(root))?.state).not.toBe('complete')
        } else {
          expect(middleCompletion).toMatchObject({
            state: 'not-complete',
            diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-coverage-not-cited' })]),
          })
        }
        expect(middleMandate.payload.parent).toEqual({ scope: root, recordId: rootMandate.recordId, kind: 'mandate' })
        const effects = {
          git: (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }),
          gh: (cwd: string, args: string[], input?: string) => {
            if (input !== undefined) throw new Error('Unexpected stdin in declared GitHub transport')
            return world.ghSync(cwd, args)
          },
          uw: world.operations,
          uwReadAuthor: 'operator',
        }
        if (mode === 'complete')
          await prepareCompletedMiddle(
            createEpicDriver(effects),
            world.operations,
            world.cwd,
            middle,
            `${proof.code.base}..${proof.code.head}`,
          )
        const result = await withEpicEffects(effects, () =>
          continueFeature({
            cwd: world.cwd,
            reference: middle.target,
            control: 'continue',
            principal: false,
            git: world.git,
            gh: world.gh,
            uw: world.operations,
          }),
        )
        expectContinuation(result, mode, root, middle, rootMandate.recordId)
      },
    )
  },
)
