import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { featureMandate, SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { fixtureUwOperations, standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { prepareDeliveryAction } from './delivery-action.ts'
import type { UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import * as actionObserve from './uw-action-observe.ts'
import { actionOperationMethods } from './uw-action-operations.ts'
import { createProductionInputPorts } from './uw-input-readers.ts'

it('prepares plan and plan-review against the same accepted UW Spec', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'plan-review-preparation-'))
  const base = standaloneReviewInputs()
  const mandate = featureMandate()
  const decoded = roxabiWorkflowFixtures().historyFrom([mandate])
  const pluginBytes = Buffer.from('fixture plugin')
  const observe = vi.spyOn(actionObserve, 'observeCode').mockResolvedValue({
    ok: true,
    value: { branch: 'feature/bounded', baseName: 'main' },
  })
  const config = vi.spyOn(actionObserve, 'configuration').mockResolvedValue({
    ok: true,
    value: base.manifest.configuration,
  })
  const histories = vi.spyOn(actionObserve, 'readHistories').mockResolvedValue({ ok: true, value: [decoded] })
  try {
    const { readPinnedFiles: _readPinnedFiles, ...production } = createProductionInputPorts({
      cwd: directory,
      gh: async () => {
        throw new Error('accepted Spec must not read the proposed issue body')
      },
    })
    let placement = 0
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
          const root = join(directory, `snapshot-${placement++}`)
          for (const file of files) {
            const path = join(root, file.path)
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, file.bytes)
          }
          return { ok: true, value: { indexPath: join(root, 'index.md'), location: 'local' } }
        },
      },
    }
    const operations = { ...fixtureUwOperations(), ...actionOperationMethods({ actions: ports }) }
    const request: UwActionRequest = {
      actionId: 'plan-action',
      purpose: 'plan',
      subject: { kind: 'uw', uw: SCOPE, pullRequest: null, binding: null },
      code: { ...base.manifest.code, repository: SCOPE.repository },
      stageSources: [],
      expandedContext: [],
    }
    const plan = await prepareDeliveryAction(operations, request)
    expect(plan.ok).toBe(true)
    const review = await prepareDeliveryAction(operations, {
      ...request,
      actionId: 'plan-review-action',
      purpose: 'plan-review',
    })
    expect(review.ok).toBe(true)
    if (!plan.ok || !review.ok) return
    expect(plan.value.inputs.manifest.spec.kind).toBe('accepted')
    expect(review.value.inputs.manifest.spec).toEqual(plan.value.inputs.manifest.spec)
    expect(review.value.inputs.manifest.acceptedSources).toEqual(plan.value.inputs.manifest.acceptedSources)
    expect(review.value.inputs.manifest.configuration).toEqual(plan.value.inputs.manifest.configuration)
  } finally {
    observe.mockRestore()
    config.mockRestore()
    histories.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
