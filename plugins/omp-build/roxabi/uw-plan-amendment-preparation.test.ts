import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as contracts from '../contracts.ts'
import { canonicalValueDigest } from '../dist/contracts.js'
import { fixtureUwOperations, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { BODY, SCOPE } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import * as delivery from './delivery-action.ts'
import * as engine from './feature-engine.ts'
import { planAction } from './feature-plan-start.ts'
import type { UwActionPorts } from './uw-action-contract.ts'
import * as actionObserve from './uw-action-observe.ts'
import { actionOperationMethods } from './uw-action-operations.ts'
import { createProductionInputPorts } from './uw-input-readers.ts'

it('prepares one amendment from the selected draft and both original specialist review values', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-amendment-preparation-'))
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(SCOPE, { body: BODY })
  const draft = fixtures.planDraftRecords(mandate)
  const review = fixtures.planReviewRecord(mandate, 'act-plan-1', fixtures.publishedPlanDigest(), [
    fixtures.blockingPlanContribution('slot-architect', 'R-workflow-plan-architect', 'plan-block-1'),
    fixtures.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
  ])
  if (review.payload.phase !== 'result' || review.payload.action !== 'plan-review')
    throw new Error('expected review result')
  const history = fixtures.historyFrom([
    mandate,
    ...draft,
    fixtures.planReviewStart(mandate, 'act-plan-1', fixtures.publishedPlanDigest()),
    review,
  ])
  const evidence = { issue: history, pullRequest: null, parents: [] }
  const base = standaloneReviewInputs()
  const pluginBytes = Buffer.from('fixture plugin')
  const observe = vi
    .spyOn(actionObserve, 'observeCode')
    .mockResolvedValue({ ok: true, value: { branch: 'feature/bounded', baseName: 'main' } })
  const config = vi
    .spyOn(actionObserve, 'configuration')
    .mockResolvedValue({ ok: true, value: base.manifest.configuration })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [history] })
  const publish = vi.spyOn(engine, 'publishRecord').mockResolvedValue({ ok: true })
  const confirm = vi.spyOn(delivery, 'confirmStartReadback').mockResolvedValue({ ok: true })
  try {
    const gh = async () => {
      throw new Error('unexpected live GitHub read')
    }
    const { readPinnedFiles: _readPinnedFiles, ...production } = createProductionInputPorts({ cwd: directory, gh })
    const ports: UwActionPorts = {
      ...production,
      readPinnedFile: async () => ({ ok: true, value: pluginBytes }),
      readCodeDiff: async () => ({ ok: true, value: Buffer.from('diff') }),
      repositoryReferences: async () => ({ ok: true, value: [] }),
      plugin: {
        resolveInstalledPluginPin: async () => ({
          ok: true,
          value: {
            name: 'omp-build',
            version: base.manifest.plugin.version,
            repository: base.manifest.plugin.repository,
            commit: base.manifest.plugin.commit,
            root: base.manifest.plugin.root,
          },
        }),
        readInstalledFile: async () => ({ ok: true, value: pluginBytes }),
      },
      snapshots: {
        create: async ({ files }) => {
          for (const file of files) {
            const path = join(directory, file.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, file.bytes)
          }
          return { ok: true, value: { indexPath: join(directory, 'index.md'), location: 'local' } }
        },
      },
    }
    const operations = { ...fixtureUwOperations(), ...actionOperationMethods({ actions: ports }) }
    const result = await planAction(
      contracts,
      evidence,
      history,
      gh,
      directory,
      SCOPE,
      mandate,
      operations,
      async () => ({ code: 0, stdout: '1111111111111111111111111111111111111111', stderr: '' }),
    )
    expect(result.kind).toBe('action')
    if (result.kind !== 'action') throw new Error(JSON.stringify(result))
    expect(result.node).toBe('plan')
    expect(result.followUp.tasks.tasks).toHaveLength(1)
    const task = result.followUp.tasks.tasks[0]
    expect(task.agent).toBe('R-workflow-plan')
    expect(task.task).toContain('Index: ' + join(directory, 'index.md'))
    expect(task.task).not.toContain(JSON.stringify(review.payload.contributions))
    const manifest = task.action.inputs.manifest
    expect(manifest.deliveryData.filter((ref) => ref.role === 'plan')).toHaveLength(1)
    expect(manifest.expandedContext).toEqual([
      {
        source: 'record',
        record: { scope: SCOPE, recordId: review.recordId, kind: 'action-receipt' },
        selector: '/payload/slots',
        digest: canonicalValueDigest(review.payload.slots),
      },
      {
        source: 'record',
        record: { scope: SCOPE, recordId: review.recordId, kind: 'action-receipt' },
        selector: '/payload/contributions',
        digest: canonicalValueDigest(review.payload.contributions),
      },
    ])
    expect(JSON.parse(readFileSync(join(directory, 'stage/annex.json'), 'utf8'))).toEqual([])
    expect(JSON.parse(readFileSync(join(directory, 'expanded/0.json'), 'utf8'))).toEqual(review.payload.slots)
    expect(JSON.parse(readFileSync(join(directory, 'expanded/1.json'), 'utf8'))).toEqual(review.payload.contributions)
    expect(readFileSync(join(directory, 'index.md'), 'utf8')).toContain('expanded/0.json')
    expect(readFileSync(join(directory, 'index.md'), 'utf8')).toContain('expanded/1.json')
    const start = publish.mock.calls[0][2]
    expect(start.payload).toMatchObject({
      exactInputs: {
        amendsReviewActionId: 'act-plan-review-1',
        requiredBlockers: [{ sourceId: 'slot-architect', slotId: 'slot-architect', blockerId: 'plan-block-1' }],
      },
    })
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
    publish.mockRestore()
    confirm.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
